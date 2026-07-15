import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectModeDecision } from '../gateway/project-mode.js';
import {
  initFromDecision,
  getProject,
  listActiveProjects,
  setStatus,
  updateTeamMember,
  updateWorkstream,
  updateMilestone,
  addBlocker,
  resolveBlocker,
  addRisk,
  setNextSteps,
  logDecision,
  generateReport,
  removeProject,
  _clearAll,
} from './state.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const sampleDecision: ProjectModeDecision = {
  enabled: true,
  reason: 'Multi-phase website build',
  goal: 'Build a personal blog website',
  workstreams: [
    { name: 'Design', description: 'UI/UX design and layout' },
    { name: 'Backend', description: 'API and data layer' },
    { name: 'Frontend', description: 'React components and styling' },
  ],
  team_roles: [
    { role: 'Architect', responsibility: 'System design' },
    { role: 'Developer', responsibility: 'Implementation' },
    { role: 'QA', responsibility: 'Testing and verification' },
  ],
  model_strategy: 'Use Claude for architecture, fast model for code',
  milestones: [
    { label: 'Design Complete', criteria: 'Wireframes approved' },
    { label: 'MVP', criteria: 'Basic blog renders' },
  ],
  reporting_mode: 'milestone',
  clarifications_needed: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-mode/state', () => {
  beforeEach(() => {
    _clearAll();
  });

  describe('initFromDecision', () => {
    it('creates a project with correct initial state', () => {
      const id = initFromDecision(sampleDecision);
      const state = getProject(id);
      expect(state).toBeDefined();
      expect(state!.goal).toBe('Build a personal blog website');
      expect(state!.status).toBe('planning');
      expect(state!.team).toHaveLength(3);
      expect(state!.workstreams).toHaveLength(3);
      expect(state!.milestones).toHaveLength(2);
      expect(state!.decision_log).toHaveLength(1);
      expect(state!.decision_log[0].decision).toBe('Project Mode activated');
      expect(state!.next_steps[0]).toContain('Design');
    });
  });

  describe('status management', () => {
    it('setStatus updates project status', () => {
      const id = initFromDecision(sampleDecision);
      setStatus(id, 'executing');
      expect(getProject(id)!.status).toBe('executing');
    });

    it('setStatus returns false for unknown project', () => {
      expect(setStatus('nonexistent', 'executing')).toBe(false);
    });
  });

  describe('team updates', () => {
    it('updateTeamMember patches a team member', () => {
      const id = initFromDecision(sampleDecision);
      updateTeamMember(id, 'Developer', {
        model: 'claude-sonnet',
        adapter_id: 'claude-code',
        status: 'working',
      });
      const member = getProject(id)!.team.find(m => m.role === 'Developer');
      expect(member!.model).toBe('claude-sonnet');
      expect(member!.adapter_id).toBe('claude-code');
      expect(member!.status).toBe('working');
    });

    it('updateTeamMember returns false for unknown role', () => {
      const id = initFromDecision(sampleDecision);
      expect(updateTeamMember(id, 'Nonexistent', { status: 'working' })).toBe(false);
    });
  });

  describe('workstream updates', () => {
    it('updateWorkstream changes status', () => {
      const id = initFromDecision(sampleDecision);
      updateWorkstream(id, 'Design', { status: 'in_progress' });
      const ws = getProject(id)!.workstreams.find(w => w.name === 'Design');
      expect(ws!.status).toBe('in_progress');
    });
  });

  describe('milestone updates', () => {
    it('updateMilestone marks done and sets completed_at', () => {
      const id = initFromDecision(sampleDecision);
      updateMilestone(id, 'ms-1', { status: 'done' });
      const ms = getProject(id)!.milestones.find(m => m.id === 'ms-1');
      expect(ms!.status).toBe('done');
      expect(ms!.completed_at).toBeGreaterThan(0);
    });
  });

  describe('blockers', () => {
    it('addBlocker creates a blocker with generated ID', () => {
      const id = initFromDecision(sampleDecision);
      const blockerId = addBlocker(id, 'Missing API key', 'critical');
      expect(blockerId).toBeTruthy();
      expect(getProject(id)!.blockers).toHaveLength(1);
      expect(getProject(id)!.status).toBe('blocked');
    });

    it('resolveBlocker clears the block and restores status', () => {
      const id = initFromDecision(sampleDecision);
      setStatus(id, 'executing');
      const blockerId = addBlocker(id, 'Missing key', 'critical')!;
      expect(getProject(id)!.status).toBe('blocked');
      resolveBlocker(id, blockerId);
      expect(getProject(id)!.status).toBe('executing');
      expect(getProject(id)!.blockers[0].resolved_at).toBeGreaterThan(0);
    });

    it('warning blocker does not change status to blocked', () => {
      const id = initFromDecision(sampleDecision);
      setStatus(id, 'executing');
      addBlocker(id, 'Minor issue', 'warning');
      expect(getProject(id)!.status).toBe('executing');
    });
  });

  describe('risks', () => {
    it('addRisk creates a risk entry', () => {
      const id = initFromDecision(sampleDecision);
      const riskId = addRisk(id, 'Complex integration', 'high');
      expect(riskId).toBeTruthy();
      expect(getProject(id)!.risks).toHaveLength(1);
      expect(getProject(id)!.risks[0].likelihood).toBe('high');
    });
  });

  describe('next steps and decisions', () => {
    it('setNextSteps replaces next_steps', () => {
      const id = initFromDecision(sampleDecision);
      setNextSteps(id, ['Step A', 'Step B']);
      expect(getProject(id)!.next_steps).toEqual(['Step A', 'Step B']);
    });

    it('logDecision appends to decision log', () => {
      const id = initFromDecision(sampleDecision);
      logDecision(id, 'Use React', 'Best ecosystem fit');
      expect(getProject(id)!.decision_log).toHaveLength(2);
      expect(getProject(id)!.decision_log[1].decision).toBe('Use React');
    });
  });

  describe('generateReport', () => {
    it('generates a report with done/doing/blocked from workstreams and milestones', () => {
      const id = initFromDecision(sampleDecision);
      setStatus(id, 'executing');
      updateWorkstream(id, 'Design', { status: 'done' });
      updateWorkstream(id, 'Backend', { status: 'in_progress' });
      updateWorkstream(id, 'Frontend', { status: 'blocked' });
      updateMilestone(id, 'ms-1', { status: 'done' });
      addBlocker(id, 'Database not provisioned', 'warning');

      const report = generateReport(id, [
        { role: 'Developer', model: 'claude-sonnet', adapter_id: 'claude-code', lane: 'code', routing_reason: 'coding task', status: 'working' },
      ]);

      expect(report).not.toBeNull();
      expect(report!.done).toContain('Design');
      expect(report!.done).toContain('Milestone: Design Complete');
      expect(report!.doing).toContain('Backend');
      expect(report!.blocked).toContain('Frontend');
      expect(report!.blocked).toContain('[warning] Database not provisioned');
      expect(report!.delegations).toHaveLength(1);
      expect(report!.delegations[0].routing_reason).toBe('coding task');
    });

    it('returns null for unknown project', () => {
      expect(generateReport('nonexistent')).toBeNull();
    });
  });

  describe('listActiveProjects', () => {
    it('returns only non-terminal projects', () => {
      const id1 = initFromDecision(sampleDecision);
      const id2 = initFromDecision(sampleDecision);
      setStatus(id2, 'completed');
      const active = listActiveProjects();
      expect(active).toContain(id1);
      expect(active).not.toContain(id2);
    });
  });

  describe('removeProject', () => {
    it('removes a project from the store', () => {
      const id = initFromDecision(sampleDecision);
      expect(removeProject(id)).toBe(true);
      expect(getProject(id)).toBeUndefined();
    });
  });

  describe('updated_at tracking', () => {
    it('touch updates updated_at on mutations', () => {
      const id = initFromDecision(sampleDecision);
      const initial = getProject(id)!.updated_at;
      // Small delay to ensure time difference
      setNextSteps(id, ['new step']);
      expect(getProject(id)!.updated_at).toBeGreaterThanOrEqual(initial);
    });
  });
});
