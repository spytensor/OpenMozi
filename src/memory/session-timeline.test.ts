import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  deleteTimelineAfterLatestUserMessage,
  deleteTimelineForSessionMessage,
  getSessionTimeline,
  getSessionTimelinePage,
  linkLatestTimelineMessage,
  patchTimelineArtifactData,
  removeRuntimeDiagnosticTimelineItems,
  cloneLatestUserMessageToTurn,
  saveTimelineItem,
  terminalizeStaleRunningArtifacts,
} from './session-timeline.js';
import { saveMessage } from './conversations.js';

let tmpDir: string;

beforeEach(() => {
  const db = setupTestDb();
  tmpDir = db.tmpDir;
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

describe('memory/session-timeline', () => {
  it('paginates equal-timestamp rows with a stable row-id cursor and no loss', () => {
    for (let index = 0; index < 205; index++) {
      saveTimelineItem({
        tenantId: 'tenant-a', sessionId: 'long-session', chatId: 'chat-1', type: 'tool_event',
        eventKey: `tool:${index}`, timestamp: 1000,
        data: { id: `tool-${index}`, callId: `call-${index}`, tool: 'test', phase: 'end', timestamp: 1000 },
      });
    }
    const seen = new Set<number>();
    let before: string | undefined;
    do {
      const page = getSessionTimelinePage('long-session', { tenantId: 'tenant-a', limit: 37, before });
      for (const item of page.timeline) expect(seen.has(item.eventId)).toBe(false);
      page.timeline.forEach((item) => seen.add(item.eventId));
      before = page.nextCursor ?? undefined;
      if (!page.hasMore) break;
    } while (before);
    expect(seen.size).toBe(205);
  });

  it('persists distinct conversation identities for repeated prompts and deletes the selected one', () => {
    const first = saveMessage('chat-1', 'user', '继续', undefined, undefined, 'repeat-session', 'tenant-a');
    const second = saveMessage('chat-1', 'user', '继续', undefined, undefined, 'repeat-session', 'tenant-a');
    for (const [index, conversationId] of [first, second].entries()) {
      saveTimelineItem({
        tenantId: 'tenant-a', sessionId: 'repeat-session', chatId: 'chat-1', type: 'message',
        eventKey: `message:${index}`, timestamp: 100 + index, conversationId,
        data: { role: 'user', content: '继续', timestamp: 100 + index },
      });
    }
    expect(getSessionTimeline('repeat-session', 10, 'tenant-a').map((item) => (item.data as { id: string }).id))
      .toEqual([`conversation:${first}`, `conversation:${second}`]);

    deleteTimelineForSessionMessage({
      tenantId: 'tenant-a', sessionId: 'repeat-session', role: 'user', content: '继续',
      messageOccurrence: 2, conversationId: second,
    });
    expect(getSessionTimeline('repeat-session', 10, 'tenant-a').map((item) => (item.data as { id: string }).id))
      .toEqual([`conversation:${first}`]);
  });

  it('links streamed assistant timeline rows by final content when multiple rows are unlinked', () => {
    const first = saveMessage('chat-1', 'assistant', 'first answer', undefined, undefined, 'stream-session', 'tenant-a');
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'stream-session', chatId: 'chat-1', type: 'message',
      eventKey: 'stream:first', timestamp: 100,
      data: { role: 'assistant', content: 'first answer', timestamp: 100 },
    });
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'stream-session', chatId: 'chat-1', type: 'message',
      eventKey: 'stream:second', timestamp: 101,
      data: { role: 'assistant', content: 'second answer', timestamp: 101 },
    });

    expect(linkLatestTimelineMessage({
      tenantId: 'tenant-a', sessionId: 'stream-session', role: 'assistant',
      content: 'first answer', conversationId: first,
    })).toBe(true);
    expect(getSessionTimeline('stream-session', 10, 'tenant-a').map((item) => (item.data as { id?: string }).id))
      .toEqual([`conversation:${first}`, undefined]);
  });

  it('filters and removes accidentally persisted runtime diagnostics', () => {
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', type: 'message',
      eventKey: 'message:status', timestamp: 100,
      data: { id: 'status', role: 'assistant', content: 'Runtime Status\nTools: shell_exec', timestamp: 100 },
    });
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', type: 'message',
      eventKey: 'message:answer', timestamp: 200,
      data: { id: 'answer', role: 'assistant', content: 'Useful answer', timestamp: 200 },
    });

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toHaveLength(1);
    expect(removeRuntimeDiagnosticTimelineItems()).toBe(1);
    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ content: 'Useful answer' }) }),
    ]);
  });

  it('deletes the rendered work for one user turn but preserves the next turn', () => {
    for (const [eventKey, timestamp, role, content] of [
      ['message:user-1', 100, 'user', 'First prompt'],
      ['tool:first', 150, 'assistant', 'First work marker'],
      ['message:assistant-1', 200, 'assistant', 'First answer'],
      ['message:user-2', 300, 'user', 'Second prompt'],
      ['message:assistant-2', 400, 'assistant', 'Second answer'],
    ] as const) {
      saveTimelineItem({
        tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', type: 'message',
        eventKey, timestamp, data: { id: eventKey, role, content, timestamp },
      });
    }

    expect(deleteTimelineForSessionMessage({
      tenantId: 'tenant-a', sessionId: 'session-1', role: 'user', content: 'First prompt', messageOccurrence: 1,
    })).toBe(3);
    expect(getSessionTimeline('session-1', 20, 'tenant-a').map(item => (item.data as { content: string }).content)).toEqual([
      'Second prompt',
      'Second answer',
    ]);
  });
  it('deletes prior turn output while preserving the latest user prompt for regenerate', () => {
    for (const [eventKey, timestamp, role, content] of [
      ['message:user', 100, 'user', 'Book the hotel'],
      ['message:assistant', 200, 'assistant', 'Request failed'],
    ] as const) {
      saveTimelineItem({
        tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', type: 'message',
        eventKey, timestamp, data: { id: eventKey, role, content, timestamp },
      });
    }
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', type: 'task_update',
      eventKey: 'task:old', timestamp: 150,
      data: { id: 'task-old', task_id: 'old', title: 'Working', status: 'running', timestamp: 150 },
    });

    expect(deleteTimelineAfterLatestUserMessage('session-1', 'tenant-a')).toBe(2);
    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ role: 'user', content: 'Book the hotel' }) }),
    ]);
  });

  it('clones the retained user prompt onto the new turn for a coherent regenerate (Issue #626)', () => {
    // A prior prompt remains immutable under turn_old.
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', turnId: 'turn_old', type: 'message',
      eventKey: 'turn:turn_old:message:user', timestamp: 100,
      data: { id: 'u', role: 'user', content: 'Book the hotel', timestamp: 100 },
    });

    // The retry preserves history and clones the prompt under turn_new.
    const moved = cloneLatestUserMessageToTurn({ tenantId: 'tenant-a', sessionId: 'session-1', turnId: 'turn_new', content: 'Book the hotel' });
    expect(moved).toBe(true);

    // The new answer of the retry lands on turn_new, seq after the prompt.
    saveTimelineItem({
      tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', turnId: 'turn_new', type: 'message',
      eventKey: 'turn:turn_new:message:assistant', timestamp: 300,
      data: { id: 'a', role: 'assistant', content: 'Booked.', timestamp: 300 },
    });

    const page = getSessionTimelinePage('session-1', { tenantId: 'tenant-a' });
    const prompts = page.timeline.filter((i) => (i.data as { role?: string }).role === 'user');
    const prompt = prompts.find((i) => i.turnId === 'turn_new');
    const answer = page.timeline.find((i) => (i.data as { role?: string }).role === 'assistant');
    // The retry is ONE coherent turn: prompt and answer share the new identity,
    // the prior turn's sequence is not reused (prompt is seq 1 of turn_new).
    expect(prompt?.turnId).toBe('turn_new');
    expect(prompt?.seq).toBe(1);
    expect(answer?.turnId).toBe('turn_new');
    expect(answer?.seq).toBe(2);
    expect(prompts.find((i) => i.turnId === 'turn_old')?.seq).toBe(1);
  });

  it('clones the selected historical prompt rather than the latest prompt', () => {
    for (const [turnId, content, timestamp] of [
      ['turn_old', 'First request', 100],
      ['turn_latest', 'Latest request', 200],
    ] as const) {
      saveTimelineItem({
        tenantId: 'tenant-a', sessionId: 'session-1', chatId: 'chat-1', turnId, type: 'message',
        eventKey: `turn:${turnId}:message:user`, timestamp,
        data: { id: `u-${turnId}`, role: 'user', content, timestamp },
      });
    }
    expect(cloneLatestUserMessageToTurn({
      tenantId: 'tenant-a', sessionId: 'session-1', turnId: 'turn_retry', content: 'First request',
    })).toBe(true);
    const retry = getSessionTimelinePage('session-1', { limit: 20, tenantId: 'tenant-a' })
      .timeline.find((item) => item.turnId === 'turn_retry');
    expect(retry?.data).toEqual(expect.objectContaining({ role: 'user', content: 'First request' }));
    expect(cloneLatestUserMessageToTurn({
      tenantId: 'tenant-a', sessionId: 'session-1', turnId: 'turn_forged', content: 'Never existed',
    })).toBe(false);
  });
  it('stores and restores mixed timeline items in chronological order', () => {
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'task_update',
      eventKey: 'task:task-1',
      timestamp: 200,
      data: { id: 'task_task-1', task_id: 'task-1', title: 'Check sources', status: 'running', timestamp: 200 },
    });
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'message',
      eventKey: 'message:user',
      timestamp: 100,
      data: { id: 'msg-user', role: 'user', content: 'Research OpenClaw', timestamp: 100 },
    });
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'tool_event',
      eventKey: 'tool:call-1',
      timestamp: 300,
      data: { id: 'tool_call-1', callId: 'call-1', tool: 'web_search', phase: 'start', timestamp: 300 },
    });

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      {
        type: 'message',
        timestamp: 100,
        data: { id: 'msg-user', role: 'user', content: 'Research OpenClaw', timestamp: 100 },
      },
      {
        type: 'task_update',
        timestamp: 200,
        data: { id: 'task_task-1', task_id: 'task-1', title: 'Check sources', status: 'running', timestamp: 200 },
      },
      {
        type: 'tool_event',
        timestamp: 300,
        data: { id: 'tool_call-1', callId: 'call-1', tool: 'web_search', phase: 'start', timestamp: 300 },
      },
    ]);
  });

  it('updates existing event payloads without moving their original timeline position', () => {
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'tool_event',
      eventKey: 'tool:call-1',
      timestamp: 100,
      data: {
        id: 'tool_call-1',
        callId: 'call-1',
        tool: 'browser',
        phase: 'start',
        intent: 'Read project page',
        timestamp: 100,
      },
    });
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'tool_event',
      eventKey: 'tool:call-1',
      timestamp: 900,
      preserveTimestampOnUpdate: true,
      mergeDataOnUpdate: true,
      data: {
        id: 'tool_call-1',
        callId: 'call-1',
        tool: 'browser',
        phase: 'end',
        status: 'success',
        timestamp: 900,
      },
    });

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      {
        type: 'tool_event',
        timestamp: 100,
        data: {
          id: 'tool_call-1',
          callId: 'call-1',
          tool: 'browser',
          phase: 'end',
          status: 'success',
          intent: 'Read project page',
          timestamp: 900,
        },
      },
    ]);
  });

  it('keeps session timeline events isolated by tenant', () => {
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      saveTimelineItem({
        tenantId,
        sessionId: 'session-1',
        chatId: 'chat-1',
        type: 'message',
        eventKey: 'message:user',
        timestamp: 100,
        data: { id: tenantId, role: 'user', content: tenantId, timestamp: 100 },
      });
    }

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      {
        type: 'message',
        timestamp: 100,
        data: { id: 'tenant-a', role: 'user', content: 'tenant-a', timestamp: 100 },
      },
    ]);
  });

  it('patches persisted artifacts without replacing sibling artifact data', () => {
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'artifact',
      eventKey: 'artifact:artifact-1',
      timestamp: 100,
      data: {
        id: 'artifact-1',
        title: 'Report',
        status: 'running',
        data: { body: 'Draft', progress: 30 },
        timestamp: 100,
      },
    });

    patchTimelineArtifactData({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      artifactId: 'artifact-1',
      patch: { status: 'completed', data: { progress: 80 }, summary: 'Almost done' },
      timestamp: 200,
    });

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      {
        type: 'artifact',
        timestamp: 100,
        data: {
          id: 'artifact-1',
          title: 'Report',
          status: 'completed',
          data: { body: 'Draft', progress: 80, summary: 'Almost done' },
          timestamp: 100,
        },
      },
    ]);
  });

  it('applies a reclassifying plugin_id patch onto the envelope, not into data', () => {
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'artifact',
      eventKey: 'artifact:artifact-live',
      timestamp: 100,
      data: {
        id: 'artifact-live',
        plugin_id: 'live_work_v1',
        title: 'Live preview',
        status: 'running',
        data: { code: 'partial' },
        timestamp: 100,
      },
    });

    patchTimelineArtifactData({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      artifactId: 'artifact-live',
      patch: { plugin_id: 'html_preview_v1', status: 'completed', data: { code: 'final' } },
      timestamp: 200,
    });

    expect(getSessionTimeline('session-1', 20, 'tenant-a')).toEqual([
      {
        type: 'artifact',
        timestamp: 100,
        data: {
          id: 'artifact-live',
          plugin_id: 'html_preview_v1',
          title: 'Live preview',
          status: 'completed',
          data: { code: 'final' },
          timestamp: 100,
        },
      },
    ]);
  });

  it('terminalizes stale running artifacts to failed and leaves terminal rows alone', () => {
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'artifact',
      eventKey: 'artifact:stuck',
      timestamp: 100,
      data: { id: 'stuck', title: 'Interrupted', status: 'running', data: { step: 1 }, timestamp: 100 },
    });
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'artifact',
      eventKey: 'artifact:done',
      timestamp: 200,
      data: { id: 'done', title: 'Finished', status: 'completed', data: { step: 9 }, timestamp: 200 },
    });
    // A non-artifact row that happens to carry status: 'running' must be ignored.
    saveTimelineItem({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      chatId: 'chat-1',
      type: 'task_update',
      eventKey: 'task:t1',
      timestamp: 150,
      data: { id: 'task_t1', task_id: 't1', title: 'Work', status: 'running', timestamp: 150 },
    });

    const count = terminalizeStaleRunningArtifacts('tenant-a');
    expect(count).toBe(1);

    const items = getSessionTimeline('session-1', 20, 'tenant-a');
    const stuck = items.find((i) => (i.data as { id?: string }).id === 'stuck')!.data as Record<string, unknown>;
    expect(stuck.status).toBe('failed');
    expect((stuck.data as Record<string, unknown>).failure_reason).toBe('interrupted');
    expect((stuck.data as Record<string, unknown>).step).toBe(1);

    const done = items.find((i) => (i.data as { id?: string }).id === 'done')!.data as Record<string, unknown>;
    expect(done.status).toBe('completed');

    const task = items.find((i) => (i.data as { id?: string }).id === 'task_t1')!.data as Record<string, unknown>;
    expect(task.status).toBe('running');
  });
});

describe('memory/session-timeline — per-turn sequence (Issue #627)', () => {
  const save = (turnId: string | undefined, eventKey: string, timestamp: number, extra: Record<string, unknown> = {}) =>
    saveTimelineItem({
      tenantId: 't', sessionId: 'seq-session', chatId: 'c', turnId,
      type: 'tool_event', eventKey, timestamp,
      data: { id: eventKey, callId: eventKey, tool: 'x', phase: 'end', timestamp },
      ...extra,
    });

  it('assigns a monotonic per-turn sequence and returns it', () => {
    expect(save('turn_1', 'e1', 100).seq).toBe(1);
    expect(save('turn_1', 'e2', 100).seq).toBe(2);
    expect(save('turn_1', 'e3', 101).seq).toBe(3);
    // A different turn restarts its own sequence.
    expect(save('turn_2', 'e4', 102).seq).toBe(1);
  });

  it('leaves the sequence null for turn-less rows', () => {
    const result = save(undefined, 'legacy', 100);
    expect(result.seq).toBeNull();
    expect(result.turnId).toBeUndefined();
  });

  it('preserves the original sequence when a row is updated in place', () => {
    save('turn_1', 'e1', 100);
    const second = save('turn_1', 'e2', 100);
    expect(second.seq).toBe(2);
    // Re-save e1 (an update) — its sequence must not change or jump.
    const reSaved = saveTimelineItem({
      tenantId: 't', sessionId: 'seq-session', chatId: 'c', turnId: 'turn_1',
      type: 'tool_event', eventKey: 'e1', timestamp: 100, mergeDataOnUpdate: true,
      data: { id: 'e1', callId: 'e1', tool: 'x', phase: 'end', status: 'success', timestamp: 100 },
    });
    expect(reSaved.seq).toBe(1);
  });

  it('restore returns turnId + seq and matches live insertion order for the same event log', () => {
    // Live order = order written. Timestamps are monotonic-with-collisions, as
    // the real emit pipeline produces (Date.now() at emit, ties on the same ms).
    const liveOrder = ['a', 'b', 'c', 'd'];
    const timestamps = [100, 100, 101, 101];
    liveOrder.forEach((key, i) => save('turn_1', key, timestamps[i]));

    const page = getSessionTimelinePage('seq-session', { tenantId: 't' });
    // Restored chronological order reproduces live order.
    expect(page.timeline.map((item) => (item.data as { id: string }).id)).toEqual(liveOrder);
    // Sequence is exposed, strictly increasing, and turn identity is present.
    expect(page.timeline.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(page.timeline.every((item) => item.turnId === 'turn_1')).toBe(true);

    // Durable contract: sorting purely by seq (ignoring timestamp) still
    // reproduces live order — seq is a sufficient standalone ordering key, which
    // is what a client projects on instead of timestamp/adjacency heuristics.
    const bySeq = [...page.timeline].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(bySeq.map((item) => (item.data as { id: string }).id)).toEqual(liveOrder);
  });
});
