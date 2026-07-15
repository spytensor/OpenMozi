interface ProviderLimits {
  rpm: number;
  tpm: number;
  concurrent: number;
}

interface ProviderState {
  limits: ProviderLimits;
  requestsThisMinute: number;
  tokensThisMinute: number;
  concurrent: number;
  minuteStartMs: number;
  waitQueue: Array<{
    resolve: () => void;
    priority: number;
    estimatedTokens: number;
  }>;
}

const providers = new Map<string, ProviderState>();

/** Configure rate limits for a provider */
export function configure(provider: string, limits: ProviderLimits): void {
  const existing = providers.get(provider);
  providers.set(provider, {
    limits,
    requestsThisMinute: existing?.requestsThisMinute ?? 0,
    tokensThisMinute: existing?.tokensThisMinute ?? 0,
    concurrent: existing?.concurrent ?? 0,
    minuteStartMs: existing?.minuteStartMs ?? Date.now(),
    waitQueue: existing?.waitQueue ?? [],
  });
}

/** Acquire a rate limit permit. Waits if over limit. Lower priority number = higher priority. */
export async function acquire(provider: string, estimatedTokens: number, priority = 1): Promise<void> {
  let state = providers.get(provider);
  if (!state) return; // No limits configured, allow through

  resetMinuteIfNeeded(state);

  // Check if we can proceed immediately
  if (canProceed(state, estimatedTokens)) {
    state.requestsThisMinute++;
    state.tokensThisMinute += estimatedTokens;
    state.concurrent++;
    return;
  }

  // Wait in queue
  return new Promise<void>((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const queued = {
      resolve: () => {
        if (interval) clearInterval(interval);
        resolve();
      },
      priority,
      estimatedTokens,
    };
    state!.waitQueue.push(queued);
    // Sort by priority (lower = higher priority)
    state!.waitQueue.sort((a, b) => a.priority - b.priority);

    // Set up periodic check
    interval = setInterval(() => {
      state = providers.get(provider);
      if (!state) {
        clearInterval(interval);
        resolve();
        return;
      }
      resetMinuteIfNeeded(state);
      processQueue(state);
    }, 100);
  });
}

/** Release a concurrent slot after request completes */
export function release(provider: string): void {
  const state = providers.get(provider);
  if (!state) return;
  state.concurrent = Math.max(0, state.concurrent - 1);
  processQueue(state);
}

/** Get current state for a provider (for monitoring) */
export function getState(provider: string): { requestsThisMinute: number; tokensThisMinute: number; concurrent: number; queueLength: number } | null {
  const state = providers.get(provider);
  if (!state) return null;
  return {
    requestsThisMinute: state.requestsThisMinute,
    tokensThisMinute: state.tokensThisMinute,
    concurrent: state.concurrent,
    queueLength: state.waitQueue.length,
  };
}

function canProceed(state: ProviderState, estimatedTokens: number): boolean {
  return (
    state.requestsThisMinute < state.limits.rpm &&
    state.tokensThisMinute + estimatedTokens <= state.limits.tpm &&
    state.concurrent < state.limits.concurrent
  );
}

function resetMinuteIfNeeded(state: ProviderState): void {
  const now = Date.now();
  if (now - state.minuteStartMs >= 60_000) {
    state.requestsThisMinute = 0;
    state.tokensThisMinute = 0;
    state.minuteStartMs = now;
  }
}

function processQueue(state: ProviderState): void {
  while (state.waitQueue.length > 0) {
    const next = state.waitQueue[0];
    if (canProceed(state, next.estimatedTokens)) {
      state.waitQueue.shift();
      state.requestsThisMinute++;
      state.tokensThisMinute += next.estimatedTokens;
      state.concurrent++;
      next.resolve();
    } else {
      break;
    }
  }
}
