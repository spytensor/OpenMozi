/**
 * Project Mode — durable project state management (#180).
 *
 * Maintains a project state object that survives across turns,
 * supports incremental updates, and generates progress reports.
 */

import { randomUUID } from 'node:crypto';
import type {
  ProjectState,
  ProjectStatus,
  ProjectTeamMember,
  ProjectWorkstream,
  ProjectMilestone,
  ProjectBlocker,
  ProjectRisk,
  ProjectDecisionLogEntry,
  ProjectReport,
  DelegationEntry,
} from './types.js';
import type { ProjectModeDecision } from '../gateway/project-mode.js';

// ---------------------------------------------------------------------------
// In-memory store (keyed by project_id)
// ---------------------------------------------------------------------------

const projects = new Map<string, ProjectState>();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Create a new ProjectState from a kickoff decision.
 * Returns the project_id.
 */
export function initFromDecision(decision: ProjectModeDecision): string {
  const projectId = randomUUID();
  const now = Date.now();

  const state: ProjectState = {
    project_id: projectId,
    goal: decision.goal,
    status: 'planning',
    team: decision.team_roles.map(r => ({
      role: r.role,
      responsibility: r.responsibility,
      status: 'idle',
    })),
    workstreams: decision.workstreams.map(w => ({
      name: w.name,
      description: w.description,
      status: 'pending',
    })),
    milestones: decision.milestones.map((m, i) => ({
      id: `ms-${i + 1}`,
      label: m.label,
      criteria: m.criteria,
      status: 'pending',
    })),
    blockers: [],
    risks: [],
    next_steps: decision.workstreams.length > 0
      ? [`Begin workstream: ${decision.workstreams[0].name}`]
      : ['Start execution'],
    decision_log: [{
      timestamp: now,
      decision: 'Project Mode activated',
      rationale: decision.reason,
    }],
    reporting_mode: decision.reporting_mode || 'milestone',
    created_at: now,
    updated_at: now,
  };

  projects.set(projectId, state);
  return projectId;
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

/** Get project state by ID. */
export function getProject(projectId: string): ProjectState | undefined {
  return projects.get(projectId);
}

/** List all active (non-terminal) project IDs. */
export function listActiveProjects(): string[] {
  const active: string[] = [];
  for (const [id, state] of projects) {
    if (state.status !== 'completed' && state.status !== 'failed') {
      active.push(id);
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Mutations — all touch updated_at
// ---------------------------------------------------------------------------

function touch(state: ProjectState): void {
  state.updated_at = Date.now();
}

/** Update project status. */
export function setStatus(projectId: string, status: ProjectStatus): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  state.status = status;
  touch(state);
  return true;
}

/** Update a team member's runtime info. */
export function updateTeamMember(
  projectId: string,
  role: string,
  patch: Partial<Omit<ProjectTeamMember, 'role' | 'responsibility'>>,
): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  const member = state.team.find(m => m.role === role);
  if (!member) return false;
  Object.assign(member, patch);
  touch(state);
  return true;
}

/** Update workstream status. */
export function updateWorkstream(
  projectId: string,
  name: string,
  patch: Partial<Omit<ProjectWorkstream, 'name' | 'description'>>,
): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  const ws = state.workstreams.find(w => w.name === name);
  if (!ws) return false;
  Object.assign(ws, patch);
  touch(state);
  return true;
}

/** Update milestone status. */
export function updateMilestone(
  projectId: string,
  milestoneId: string,
  patch: Partial<Omit<ProjectMilestone, 'id' | 'label' | 'criteria'>>,
): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  const ms = state.milestones.find(m => m.id === milestoneId);
  if (!ms) return false;
  Object.assign(ms, patch);
  if (patch.status === 'done' && !ms.completed_at) {
    ms.completed_at = Date.now();
  }
  touch(state);
  return true;
}

/** Add a blocker. */
export function addBlocker(
  projectId: string,
  description: string,
  severity: 'warning' | 'critical' = 'warning',
): string | null {
  const state = projects.get(projectId);
  if (!state) return null;
  const id = `blk-${randomUUID().slice(0, 8)}`;
  state.blockers.push({ id, description, severity, detected_at: Date.now() });
  if (severity === 'critical') {
    state.status = 'blocked';
  }
  touch(state);
  return id;
}

/** Resolve a blocker. */
export function resolveBlocker(projectId: string, blockerId: string): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  const blocker = state.blockers.find(b => b.id === blockerId);
  if (!blocker) return false;
  blocker.resolved_at = Date.now();
  // If all critical blockers resolved, go back to executing
  const unresolvedCritical = state.blockers.some(b => b.severity === 'critical' && !b.resolved_at);
  if (state.status === 'blocked' && !unresolvedCritical) {
    state.status = 'executing';
  }
  touch(state);
  return true;
}

/** Add a risk. */
export function addRisk(
  projectId: string,
  description: string,
  likelihood: 'low' | 'medium' | 'high' = 'medium',
): string | null {
  const state = projects.get(projectId);
  if (!state) return null;
  const id = `risk-${randomUUID().slice(0, 8)}`;
  state.risks.push({ id, description, likelihood, detected_at: Date.now() });
  touch(state);
  return id;
}

/** Replace next_steps. */
export function setNextSteps(projectId: string, steps: string[]): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  state.next_steps = steps;
  touch(state);
  return true;
}

/** Append a decision log entry. */
export function logDecision(projectId: string, decision: string, rationale: string): boolean {
  const state = projects.get(projectId);
  if (!state) return false;
  state.decision_log.push({ timestamp: Date.now(), decision, rationale });
  touch(state);
  return true;
}

// ---------------------------------------------------------------------------
// Report generation (#181)
// ---------------------------------------------------------------------------

/**
 * Generate a ProjectReport snapshot from the current state.
 * Delegation entries are supplied externally (from worker/job state).
 */
export function generateReport(
  projectId: string,
  delegations: DelegationEntry[] = [],
): ProjectReport | null {
  const state = projects.get(projectId);
  if (!state) return null;

  const done: string[] = [];
  const doing: string[] = [];
  const blocked: string[] = [];

  for (const ws of state.workstreams) {
    const label = ws.name;
    if (ws.status === 'done') done.push(label);
    else if (ws.status === 'in_progress') doing.push(label);
    else if (ws.status === 'blocked') blocked.push(label);
  }

  for (const ms of state.milestones) {
    const label = `Milestone: ${ms.label}`;
    if (ms.status === 'done') done.push(label);
    else if (ms.status === 'in_progress') doing.push(label);
    else if (ms.status === 'blocked') blocked.push(label);
  }

  const activeBlockers = state.blockers
    .filter(b => !b.resolved_at)
    .map(b => `[${b.severity}] ${b.description}`);
  blocked.push(...activeBlockers);

  const risks = state.risks.map(r => `[${r.likelihood}] ${r.description}`);

  return {
    project_id: state.project_id,
    goal: state.goal,
    status: state.status,
    team: state.team,
    done,
    doing,
    blocked,
    risks,
    next_steps: state.next_steps,
    delegations,
    updated_at: state.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove a project from the store. */
export function removeProject(projectId: string): boolean {
  return projects.delete(projectId);
}

/** Clear all projects. Exposed for testing. */
export function _clearAll(): void {
  projects.clear();
}
