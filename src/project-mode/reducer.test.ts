import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectModeDecision } from '../gateway/project-mode.js';
import { initFromDecision, getProject, _clearAll } from './state.js';
import { applyAction, applyActions, type ProjectAction } from './reducer.js';

const decision: ProjectModeDecision = {
  enabled: true,
  reason: 'Complex task',
  goal: 'Build blog',
  workstreams: [{ name: 'Design', description: 'UI work' }],
  team_roles: [{ role: 'Dev', responsibility: 'Code' }],
  model_strategy: 'default',
  milestones: [{ label: 'MVP', criteria: 'Blog renders' }],
  reporting_mode: 'milestone',
  clarifications_needed: [],
};

describe('project-mode/reducer', () => {
  let projectId: string;

  beforeEach(() => {
    _clearAll();
    projectId = initFromDecision(decision);
  });

  it('applies set_status action', () => {
    const result = applyAction(projectId, { type: 'set_status', status: 'executing' });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.status).toBe('executing');
  });

  it('applies update_team_member action', () => {
    const result = applyAction(projectId, {
      type: 'update_team_member',
      role: 'Dev',
      patch: { model: 'gpt-4', status: 'working' },
    });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.team[0].model).toBe('gpt-4');
  });

  it('applies update_workstream action', () => {
    const result = applyAction(projectId, {
      type: 'update_workstream',
      name: 'Design',
      patch: { status: 'in_progress' },
    });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.workstreams[0].status).toBe('in_progress');
  });

  it('applies update_milestone action', () => {
    const result = applyAction(projectId, {
      type: 'update_milestone',
      milestone_id: 'ms-1',
      patch: { status: 'done' },
    });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.milestones[0].status).toBe('done');
  });

  it('applies add_blocker and returns created_id', () => {
    const result = applyAction(projectId, {
      type: 'add_blocker',
      description: 'No API key',
      severity: 'critical',
    });
    expect(result.applied).toBe(true);
    expect(result.created_id).toBeTruthy();
    expect(getProject(projectId)!.blockers).toHaveLength(1);
  });

  it('applies resolve_blocker', () => {
    const addResult = applyAction(projectId, {
      type: 'add_blocker',
      description: 'Missing env',
      severity: 'critical',
    });
    const resolveResult = applyAction(projectId, {
      type: 'resolve_blocker',
      blocker_id: addResult.created_id!,
    });
    expect(resolveResult.applied).toBe(true);
  });

  it('applies add_risk and returns created_id', () => {
    const result = applyAction(projectId, {
      type: 'add_risk',
      description: 'Complex migration',
      likelihood: 'high',
    });
    expect(result.applied).toBe(true);
    expect(result.created_id).toBeTruthy();
  });

  it('applies set_next_steps', () => {
    const result = applyAction(projectId, {
      type: 'set_next_steps',
      steps: ['Do X', 'Do Y'],
    });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.next_steps).toEqual(['Do X', 'Do Y']);
  });

  it('applies log_decision', () => {
    const result = applyAction(projectId, {
      type: 'log_decision',
      decision: 'Use React',
      rationale: 'Best fit',
    });
    expect(result.applied).toBe(true);
    expect(getProject(projectId)!.decision_log).toHaveLength(2);
  });

  it('returns applied=false for unknown project', () => {
    const result = applyAction('bogus', { type: 'set_status', status: 'executing' });
    expect(result.applied).toBe(false);
  });

  it('applyActions processes batch in order', () => {
    const actions: ProjectAction[] = [
      { type: 'set_status', status: 'executing' },
      { type: 'update_workstream', name: 'Design', patch: { status: 'in_progress' } },
      { type: 'set_next_steps', steps: ['Finish design'] },
    ];
    const results = applyActions(projectId, actions);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.applied)).toBe(true);
    expect(getProject(projectId)!.status).toBe('executing');
    expect(getProject(projectId)!.workstreams[0].status).toBe('in_progress');
    expect(getProject(projectId)!.next_steps).toEqual(['Finish design']);
  });
});
