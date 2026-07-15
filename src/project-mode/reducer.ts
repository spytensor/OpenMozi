/**
 * Project Mode — reducer for applying structured updates to project state (#180).
 *
 * Accepts action objects and applies them to the durable project state.
 * This keeps mutation logic centralized and testable.
 */

import {
  setStatus,
  updateTeamMember,
  updateWorkstream,
  updateMilestone,
  addBlocker,
  resolveBlocker,
  addRisk,
  setNextSteps,
  logDecision,
} from './state.js';
import type { ProjectStatus } from './types.js';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type ProjectAction =
  | { type: 'set_status'; status: ProjectStatus }
  | { type: 'update_team_member'; role: string; patch: { agent_id?: string; adapter_id?: string; model?: string; status?: 'idle' | 'working' | 'done' | 'failed' } }
  | { type: 'update_workstream'; name: string; patch: { status?: 'pending' | 'in_progress' | 'done' | 'blocked'; assigned_to?: string } }
  | { type: 'update_milestone'; milestone_id: string; patch: { status?: 'pending' | 'in_progress' | 'done' | 'blocked' } }
  | { type: 'add_blocker'; description: string; severity?: 'warning' | 'critical' }
  | { type: 'resolve_blocker'; blocker_id: string }
  | { type: 'add_risk'; description: string; likelihood?: 'low' | 'medium' | 'high' }
  | { type: 'set_next_steps'; steps: string[] }
  | { type: 'log_decision'; decision: string; rationale: string };

export interface ActionResult {
  applied: boolean;
  /** ID of created entity (blocker/risk), if applicable */
  created_id?: string;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply a single action to the project state.
 */
export function applyAction(projectId: string, action: ProjectAction): ActionResult {
  switch (action.type) {
    case 'set_status':
      return { applied: setStatus(projectId, action.status) };

    case 'update_team_member':
      return { applied: updateTeamMember(projectId, action.role, action.patch) };

    case 'update_workstream':
      return { applied: updateWorkstream(projectId, action.name, action.patch) };

    case 'update_milestone':
      return { applied: updateMilestone(projectId, action.milestone_id, action.patch) };

    case 'add_blocker': {
      const id = addBlocker(projectId, action.description, action.severity);
      return { applied: id !== null, created_id: id ?? undefined };
    }

    case 'resolve_blocker':
      return { applied: resolveBlocker(projectId, action.blocker_id) };

    case 'add_risk': {
      const id = addRisk(projectId, action.description, action.likelihood);
      return { applied: id !== null, created_id: id ?? undefined };
    }

    case 'set_next_steps':
      return { applied: setNextSteps(projectId, action.steps) };

    case 'log_decision':
      return { applied: logDecision(projectId, action.decision, action.rationale) };

    default:
      return { applied: false };
  }
}

/**
 * Apply a batch of actions to the project state.
 * Returns results for each action in order.
 */
export function applyActions(projectId: string, actions: ProjectAction[]): ActionResult[] {
  return actions.map(action => applyAction(projectId, action));
}
