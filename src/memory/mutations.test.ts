import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getFactsByUser } from './long-term.js';
import { applyMemoryMutation, getMemoryTurnUpdates } from './mutations.js';

let tmpDir: string;

beforeAll(() => {
  const setup = setupTestDb();
  tmpDir = setup.tmpDir;
});

afterAll(() => teardownTestDb(tmpDir));

describe('memory mutation contract', () => {
  it('counts explicit remember and auto-extract only once in the same turn', () => {
    const first = applyMemoryMutation({
      chatId: 'chat-same-turn',
      tenantId: 'tenant-same-turn',
      userId: 'user-same-turn',
      turnId: 'turn-same-turn',
      category: 'preference',
      key: 'data_first',
      value: 'Always verify data before drawing conclusions.',
      source: 'tool',
    });
    const second = applyMemoryMutation({
      chatId: 'chat-same-turn',
      tenantId: 'tenant-same-turn',
      userId: 'user-same-turn',
      turnId: 'turn-same-turn',
      category: 'decision',
      key: 'verification_rule',
      value: 'The user requires data verification before conclusions.',
      source: 'auto_extract',
      requestedAction: 'REINFORCE',
      targetFactId: first.fact.id,
    });

    expect(first.action).toBe('ADD');
    expect(second.action).toBe('NOOP');
    expect(getFactsByUser('user-same-turn', 'tenant-same-turn')).toHaveLength(1);
    expect(getMemoryTurnUpdates('turn-same-turn', 'tenant-same-turn')).toEqual([
      { factId: first.fact.id, action: 'ADD', category: 'preference' },
    ]);
  });

  it('reinforces a paraphrased memory in a later turn without adding a row', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-reinforce-a', tenantId: 'tenant-reinforce', userId: 'user-reinforce', turnId: 'turn-a',
      category: 'preference', key: 'answer_style', value: 'Give concise answers.', source: 'auto_extract',
    });
    const reinforced = applyMemoryMutation({
      chatId: 'chat-reinforce-b', tenantId: 'tenant-reinforce', userId: 'user-reinforce', turnId: 'turn-b',
      category: 'preference', key: 'response_length', value: 'The user again asked for brief responses.', source: 'auto_extract',
      requestedAction: 'REINFORCE', targetFactId: original.fact.id,
    });

    expect(reinforced.action).toBe('REINFORCE');
    expect(reinforced.fact.id).toBe(original.fact.id);
    expect(reinforced.fact.salience_score).toBeGreaterThan(original.fact.salience_score);
    expect(getFactsByUser('user-reinforce', 'tenant-reinforce')).toHaveLength(1);
  });

  it('updates a corrected memory while preserving its stable identity', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-update', tenantId: 'tenant-update', userId: 'user-update', turnId: 'turn-old',
      category: 'fact', key: 'timezone', value: 'The user is in UTC+4.', source: 'auto_extract',
    });
    const updated = applyMemoryMutation({
      chatId: 'chat-update', tenantId: 'tenant-update', userId: 'user-update', turnId: 'turn-new',
      category: 'fact', key: 'current_timezone', value: 'The user moved to UTC+8.', source: 'auto_extract_correction',
      requestedAction: 'UPDATE', targetFactId: original.fact.id,
    });

    expect(updated.action).toBe('UPDATE');
    expect(updated.fact.id).toBe(original.fact.id);
    expect(updated.fact.key).toBe('timezone');
    expect(updated.fact.value).toBe('The user moved to UTC+8.');
    expect(getFactsByUser('user-update', 'tenant-update')).toHaveLength(1);
  });

  it('treats a changed value under the same canonical key as an update', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-key-update', tenantId: 'tenant-key-update', userId: 'user-key-update', turnId: 'turn-key-old',
      category: 'preference', key: 'theme', value: 'Use dark mode.', source: 'tool',
    });
    const updated = applyMemoryMutation({
      chatId: 'chat-key-update', tenantId: 'tenant-key-update', userId: 'user-key-update', turnId: 'turn-key-new',
      category: 'preference', key: 'theme', value: 'Use light mode.', source: 'tool',
    });

    expect(updated.action).toBe('UPDATE');
    expect(updated.fact.id).toBe(original.fact.id);
    expect(updated.fact.value).toBe('Use light mode.');
    expect(updated.fact.source).toBe('tool');
    expect(getFactsByUser('user-key-update', 'tenant-key-update')).toHaveLength(1);
  });

  it('does not merge equal keys across different users', () => {
    const first = applyMemoryMutation({
      chatId: 'chat-user-a', tenantId: 'tenant-users', userId: 'user-a', turnId: 'turn-user-a',
      category: 'preference', key: 'theme', value: 'Use dark mode.', source: 'manual',
    });
    const second = applyMemoryMutation({
      chatId: 'chat-user-b', tenantId: 'tenant-users', userId: 'user-b', turnId: 'turn-user-b',
      category: 'preference', key: 'theme', value: 'Use light mode.', source: 'manual',
    });

    expect(first.action).toBe('ADD');
    expect(second.action).toBe('ADD');
    expect(first.fact.id).not.toBe(second.fact.id);
  });
});
