import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueSteer,
  drainSteer,
  peekSteerCount,
  markBrainActivity,
  STEER_MAX_LENGTH,
  STEER_MAX_PER_TURN,
  STEER_GC_AGE_MS,
  PROMPT_CACHE_TTL_MS,
  __resetSteerStoreForTests,
  __setLastBrainAtForTests,
  __injectPendingEntryForTests,
  __peekMapSizesForTests,
} from './steer-store.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

describe('gateway/steer-store', () => {
  let dbDir: string;

  beforeEach(() => {
    __resetSteerStoreForTests();
    const result = setupTestDb();
    dbDir = result.tmpDir;
    return () => teardownTestDb(dbDir);
  });

  it('enqueue happy path — accepted, counted', () => {
    const res = enqueueSteer('chat-1', 'switch to Python');
    expect(res.accepted).toBe(true);
    expect(peekSteerCount('chat-1')).toBe(1);
  });

  it('rejects non-string', () => {
    const res = enqueueSteer('chat-1', 42 as unknown as string);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('not_string');
  });

  it('rejects empty and whitespace-only', () => {
    expect(enqueueSteer('chat-1', '').accepted).toBe(false);
    expect(enqueueSteer('chat-1', '   ').accepted).toBe(false);
  });

  it(`rejects text > ${STEER_MAX_LENGTH} chars`, () => {
    const tooLong = 'x'.repeat(STEER_MAX_LENGTH + 1);
    const res = enqueueSteer('chat-1', tooLong);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('too_long');
  });

  it(`rate-limits after ${STEER_MAX_PER_TURN} entries per chat`, () => {
    for (let i = 0; i < STEER_MAX_PER_TURN; i++) {
      expect(enqueueSteer('chat-1', `steer ${i}`).accepted).toBe(true);
    }
    const over = enqueueSteer('chat-1', 'one too many');
    expect(over.accepted).toBe(false);
    expect(over.reason).toBe('rate_limited');
    expect(peekSteerCount('chat-1')).toBe(STEER_MAX_PER_TURN);
  });

  it('drain returns queue and clears state', () => {
    enqueueSteer('chat-1', 'a');
    enqueueSteer('chat-1', 'b');
    const drained = drainSteer('chat-1');
    expect(drained).toEqual(['a', 'b']);
    expect(peekSteerCount('chat-1')).toBe(0);
    expect(drainSteer('chat-1')).toEqual([]);
  });

  it('isolates state across chatIds', () => {
    enqueueSteer('chat-A', 'alpha');
    enqueueSteer('chat-B', 'bravo');
    expect(drainSteer('chat-A')).toEqual(['alpha']);
    expect(drainSteer('chat-B')).toEqual(['bravo']);
  });

  it('allows re-enqueue after drain (next turn reset)', () => {
    for (let i = 0; i < STEER_MAX_PER_TURN; i++) {
      enqueueSteer('chat-1', `a${i}`);
    }
    drainSteer('chat-1');
    expect(enqueueSteer('chat-1', 'new turn').accepted).toBe(true);
  });

  // --- #263 review fixes ---

  describe('brainIdle flag (§10 Fallback Discipline)', () => {
    it('returns brainIdle=true when no prior brain activity recorded', () => {
      const res = enqueueSteer('chat-idle', 'hello');
      expect(res.accepted).toBe(true);
      expect(res.brainIdle).toBe(true);
    });

    it('returns brainIdle=false when brain active just now', () => {
      markBrainActivity('chat-hot');
      const res = enqueueSteer('chat-hot', 'hello');
      expect(res.brainIdle).toBe(false);
    });

    it('returns brainIdle=true when brain activity is older than PROMPT_CACHE_TTL', () => {
      __setLastBrainAtForTests('chat-stale', Date.now() - (PROMPT_CACHE_TTL_MS + 1000));
      const res = enqueueSteer('chat-stale', 'hello');
      expect(res.brainIdle).toBe(true);
    });
  });

  describe('garbage collection (map leak prevention)', () => {
    it('reclaims chatIds whose entries AND lastBrainAt are both stale', () => {
      const old = Date.now() - (STEER_GC_AGE_MS + 60_000);
      __injectPendingEntryForTests('chat-stale', 'old steer', old);
      __setLastBrainAtForTests('chat-stale', old);

      // Any fresh enqueue triggers opportunistic GC.
      enqueueSteer('chat-fresh', 'new');

      const { pending } = __peekMapSizesForTests();
      expect(pending).toBe(1); // only chat-fresh survived; chat-stale reclaimed
    });

    it('does NOT reclaim chatIds with fresh lastBrainAt even if entries are old', () => {
      const old = Date.now() - (STEER_GC_AGE_MS + 60_000);
      __injectPendingEntryForTests('chat-quiet', 'old steer', old);
      markBrainActivity('chat-quiet'); // brain is active recently

      enqueueSteer('chat-trigger', 'new');

      expect(peekSteerCount('chat-quiet')).toBe(1);
      const { pending } = __peekMapSizesForTests();
      expect(pending).toBe(2); // chat-quiet + chat-trigger
    });

    it('reclaims orphan lastBrainAt entries (chat with no pending queue)', () => {
      __setLastBrainAtForTests('chat-orphan', Date.now() - (STEER_GC_AGE_MS + 60_000));
      enqueueSteer('chat-new', 'fresh');
      const { lastBrain } = __peekMapSizesForTests();
      // chat-orphan's stale lastBrainAt should be reclaimed; chat-new never
      // called markBrainActivity, so no lastBrainAt entries remain at all.
      expect(lastBrain).toBe(0);
    });
  });
});
