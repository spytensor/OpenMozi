/**
 * Project Mode — shared types for durable project state,
 * progress tracking, and delegation transparency.
 */

// ---------------------------------------------------------------------------
// Project state (#180)
// ---------------------------------------------------------------------------

export type ProjectStatus = 'planning' | 'executing' | 'blocked' | 'completed' | 'failed';

export interface ProjectTeamMember {
  role: string;
  responsibility: string;
  agent_id?: string;
  adapter_id?: string;
  model?: string;
  status: 'idle' | 'working' | 'done' | 'failed';
}

export interface ProjectMilestone {
  id: string;
  label: string;
  criteria: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  completed_at?: number;
}

export interface ProjectWorkstream {
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  assigned_to?: string;
}

export interface ProjectBlocker {
  id: string;
  description: string;
  severity: 'warning' | 'critical';
  detected_at: number;
  resolved_at?: number;
}

export interface ProjectRisk {
  id: string;
  description: string;
  likelihood: 'low' | 'medium' | 'high';
  detected_at: number;
}

export interface ProjectDecisionLogEntry {
  timestamp: number;
  decision: string;
  rationale: string;
}

export interface ProjectState {
  project_id: string;
  goal: string;
  status: ProjectStatus;
  team: ProjectTeamMember[];
  workstreams: ProjectWorkstream[];
  milestones: ProjectMilestone[];
  blockers: ProjectBlocker[];
  risks: ProjectRisk[];
  next_steps: string[];
  decision_log: ProjectDecisionLogEntry[];
  reporting_mode: string;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Delegation routing rationale (#182)
// ---------------------------------------------------------------------------

export interface DelegationEntry {
  role: string;
  agent_id?: string;
  adapter_id?: string;
  model?: string;
  lane?: string;
  sandbox_profile?: string;
  routing_reason?: string;
  verify_status?: string;
  blocker?: string;
  status: 'queued' | 'working' | 'done' | 'failed' | 'blocked';
}

// ---------------------------------------------------------------------------
// Project report snapshot (#181 + #182)
// ---------------------------------------------------------------------------

export interface ProjectReport {
  project_id: string;
  goal: string;
  status: ProjectStatus;
  team: ProjectTeamMember[];
  done: string[];
  doing: string[];
  blocked: string[];
  risks: string[];
  next_steps: string[];
  delegations: DelegationEntry[];
  updated_at: number;
}
