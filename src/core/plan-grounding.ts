/**
 * Plan Grounding — injects the CURRENT persisted plan state into each brain
 * turn so MOZI never relies on conversation memory for plan progress.
 *
 * Context windows get compacted, sessions restart, processes crash. The
 * `tasks` table survives all of that, so every turn re-reads it and the Brain
 * is told, explicitly, what is running / done / failed right now. This block
 * is runtime truth: the Brain must trust it over anything it remembers.
 */

import { listPlanRootTasks, listTasks, type TaskRecord } from '../store/task-dag.js';
import { loadTaskMetadata } from '../tasks/workspace.js';

/** How many plans to surface per turn (newest first). */
const MAX_PLANS = 3;

/** Completed plans stay visible for follow-up questions for this long. */
const COMPLETED_VISIBILITY_MS = 6 * 60 * 60 * 1000;

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending',
  ready: 'pending',
  assigned: 'running',
  running: 'running',
  blocked: 'blocked',
  completed: 'done',
  failed: 'FAILED',
  cancelled: 'cancelled',
};

function formatStep(step: TaskRecord, index: number): string {
  const label = STATUS_LABEL[step.status] ?? step.status;
  return `  ${index + 1}. [${label}] ${step.title}`;
}

/**
 * Build the active-plan context block for a chat, or null when the chat has
 * no plans worth grounding. Synchronous by design (better-sqlite3 + local fs)
 * so it can run in the turn's hot path.
 */
export function buildActivePlanContext(chatId: string, tenantId = 'default'): string | null {
  let roots: TaskRecord[];
  try {
    roots = listPlanRootTasks(tenantId, { limit: 20 });
  } catch {
    return null;
  }

  const now = Date.now();
  const relevant: Array<{ root: TaskRecord; steps: TaskRecord[] }> = [];
  for (const root of roots) {
    if (relevant.length >= MAX_PLANS) break;
    const meta = loadTaskMetadata(root.id);
    if (meta?.chat_id !== chatId) continue;
    const terminal = root.status === 'completed' || root.status === 'failed' || root.status === 'cancelled';
    if (terminal) {
      const updatedAt = Date.parse(`${root.updated_at}Z`);
      if (Number.isFinite(updatedAt) && now - updatedAt > COMPLETED_VISIBILITY_MS) continue;
    }
    relevant.push({ root, steps: listTasks({ tenant_id: tenantId, parent_task_id: root.id }) });
  }

  if (relevant.length === 0) return null;

  const blocks = relevant.map(({ root, steps }) => {
    const done = steps.filter((s) => s.status === 'completed').length;
    const failedSteps = steps.filter((s) => s.status === 'failed');
    const headline = `Plan "${root.title}" (id: ${root.id}) — status: ${root.status}, ${done}/${steps.length} steps done`;
    const lines = steps.map(formatStep);
    const failures = failedSteps.length > 0
      ? [`  Failures: ${failedSteps.map((s) => s.title).join('; ')} — use repair_task or get_task for details.`]
      : [];
    return [headline, ...lines, ...failures].join('\n');
  });

  return [
    '[Active plan state — read from the runtime database this turn. Trust THIS over conversation memory.]',
    ...blocks,
    'Rules: do not re-decompose a plan that is already running; report progress from this block when the user asks; for a failed plan, diagnose with get_task / repair_task instead of restarting from scratch. Results are delivered by the runtime when a running plan finishes.',
  ].join('\n');
}
