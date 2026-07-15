/**
 * End-to-end test for Project Mode flow (#183).
 *
 * Simulates a multi-phase "Design a personal blog website" task
 * through the full Project Mode lifecycle:
 * 1. Kickoff decision (project-mode evaluator)
 * 2. Durable state initialization
 * 3. Progress updates via reducer
 * 4. Report generation with delegation entries
 * 5. Rendering for user visibility
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectModeDecision } from '../gateway/project-mode.js';
import { renderKickoffCard, formatKickoffCardMarkdown, buildProjectModeDirective } from '../gateway/project-mode.js';
import { initFromDecision, getProject, generateReport, _clearAll } from './state.js';
import { applyActions, type ProjectAction } from './reducer.js';
import { renderProjectReport, renderProgressUpdate, renderDelegationReport } from './renderer.js';
import { emit, on, removeAllListeners, type ProgressEvent } from '../progress/event-bus.js';
import { formatProgressText } from '../progress/progress-reporter.js';

// ---------------------------------------------------------------------------
// Scenario: "Design a personal technical blog website from scratch"
// ---------------------------------------------------------------------------

const blogDecision: ProjectModeDecision = {
  enabled: true,
  reason: 'Multi-phase website design and implementation requiring coordinated design, backend, frontend, and deployment work',
  goal: 'Design and build a personal technical blog website from scratch',
  workstreams: [
    { name: 'Design System', description: 'Create visual identity, color palette, typography, and component library' },
    { name: 'Backend API', description: 'Build content management API with markdown parsing and metadata' },
    { name: 'Frontend', description: 'React components, routing, and responsive layout' },
    { name: 'Deployment', description: 'CI/CD pipeline, hosting configuration, and domain setup' },
  ],
  team_roles: [
    { role: 'PM / Planner', responsibility: 'Coordinate workstreams and track milestones' },
    { role: 'Designer', responsibility: 'UI/UX design and component styling' },
    { role: 'Backend Developer', responsibility: 'API implementation and data modeling' },
    { role: 'Frontend Developer', responsibility: 'React components and page assembly' },
    { role: 'QA / Reviewer', responsibility: 'Testing, code review, and acceptance verification' },
  ],
  model_strategy: 'Opus for architecture/planning, Sonnet for implementation, Haiku for quick checks',
  milestones: [
    { label: 'Design System Ready', criteria: 'Color palette, typography, and 5+ components defined' },
    { label: 'API MVP', criteria: 'Blog posts CRUD API works with markdown' },
    { label: 'Frontend MVP', criteria: 'Homepage, post list, and post detail pages render' },
    { label: 'Deployed', criteria: 'Site accessible via public URL' },
  ],
  reporting_mode: 'milestone',
  clarifications_needed: ['Preferred hosting provider?', 'Any existing brand guidelines?'],
};

describe('project-mode e2e: blog website design task', () => {
  beforeEach(() => {
    _clearAll();
    removeAllListeners();
  });

  it('Phase 1: kickoff card renders correctly', () => {
    const card = renderKickoffCard(blogDecision);
    const md = formatKickoffCardMarkdown(card);

    // Verify all required kickoff card sections
    expect(md).toContain('## Project Mode Activated');
    expect(md).toContain('### Goal');
    expect(md).toContain('personal technical blog');
    expect(md).toContain('### Plan');
    expect(md).toContain('Design System');
    expect(md).toContain('Backend API');
    expect(md).toContain('Frontend');
    expect(md).toContain('Deployment');
    expect(md).toContain('### Team');
    expect(md).toContain('PM / Planner');
    expect(md).toContain('Designer');
    expect(md).toContain('Backend Developer');
    expect(md).toContain('Frontend Developer');
    expect(md).toContain('QA / Reviewer');
    expect(md).toContain('### Model Strategy');
    expect(md).toContain('Opus');
    expect(md).toContain('Sonnet');
    expect(md).toContain('### Milestones');
    expect(md).toContain('Design System Ready');
    expect(md).toContain('API MVP');
    expect(md).toContain('### Open Questions');
    expect(md).toContain('hosting provider');

    // System directive is injected
    const directive = buildProjectModeDirective(card);
    expect(directive).toContain('[PROJECT MODE');
    expect(directive).toContain('Work through each workstream sequentially');
    expect(directive).toContain('send_progress_report');
    expect(directive).toContain('Design System');
    expect(directive).toContain('Backend API');
  });

  it('Phase 2: durable state initializes from decision', () => {
    const projectId = initFromDecision(blogDecision);
    const state = getProject(projectId)!;

    expect(state.status).toBe('planning');
    expect(state.team).toHaveLength(5);
    expect(state.workstreams).toHaveLength(4);
    expect(state.milestones).toHaveLength(4);
    expect(state.next_steps[0]).toContain('Design System');
    expect(state.decision_log[0].decision).toBe('Project Mode activated');
  });

  it('Phase 3: progress updates via reducer actions', () => {
    const projectId = initFromDecision(blogDecision);

    // Simulate execution lifecycle
    const actions: ProjectAction[] = [
      // Start executing
      { type: 'set_status', status: 'executing' },
      // Assign team members
      { type: 'update_team_member', role: 'Designer', patch: { model: 'claude-sonnet-4', status: 'working' } },
      { type: 'update_team_member', role: 'PM / Planner', patch: { model: 'claude-opus-4', status: 'working' } },
      // Start design workstream
      { type: 'update_workstream', name: 'Design System', patch: { status: 'in_progress', assigned_to: 'Designer' } },
      { type: 'update_milestone', milestone_id: 'ms-1', patch: { status: 'in_progress' } },
      // Log a decision
      { type: 'log_decision', decision: 'Use Tailwind CSS', rationale: 'Rapid prototyping support' },
      // Add a risk
      { type: 'add_risk', description: 'Deployment provider selection pending', likelihood: 'medium' },
      // Set next steps
      { type: 'set_next_steps', steps: ['Complete color palette', 'Define typography scale', 'Create button component'] },
    ];

    const results = applyActions(projectId, actions);
    expect(results.every(r => r.applied)).toBe(true);

    const state = getProject(projectId)!;
    expect(state.status).toBe('executing');
    expect(state.team.find(m => m.role === 'Designer')!.status).toBe('working');
    expect(state.workstreams.find(w => w.name === 'Design System')!.status).toBe('in_progress');
    expect(state.decision_log).toHaveLength(2);
    expect(state.risks).toHaveLength(1);
  });

  it('Phase 4: blocker detection and resolution', () => {
    const projectId = initFromDecision(blogDecision);
    applyActions(projectId, [
      { type: 'set_status', status: 'executing' },
    ]);

    // Detect a blocker
    const blockerResult = applyActions(projectId, [
      { type: 'add_blocker', description: 'Redis not available for session store', severity: 'critical' },
    ]);
    expect(blockerResult[0].applied).toBe(true);
    expect(getProject(projectId)!.status).toBe('blocked');

    // Resolve it
    applyActions(projectId, [
      { type: 'resolve_blocker', blocker_id: blockerResult[0].created_id! },
    ]);
    expect(getProject(projectId)!.status).toBe('executing');
  });

  it('Phase 5: report generation with delegation entries', () => {
    const projectId = initFromDecision(blogDecision);
    applyActions(projectId, [
      { type: 'set_status', status: 'executing' },
      { type: 'update_workstream', name: 'Design System', patch: { status: 'done' } },
      { type: 'update_workstream', name: 'Backend API', patch: { status: 'in_progress' } },
      { type: 'update_milestone', milestone_id: 'ms-1', patch: { status: 'done' } },
      { type: 'update_milestone', milestone_id: 'ms-2', patch: { status: 'in_progress' } },
      { type: 'update_team_member', role: 'Backend Developer', patch: { model: 'claude-sonnet-4', adapter_id: 'claude-code', status: 'working' } },
      { type: 'add_risk', description: 'Markdown parser edge cases', likelihood: 'low' },
      { type: 'set_next_steps', steps: ['Implement post CRUD API', 'Add markdown rendering'] },
    ]);

    const report = generateReport(projectId, [
      {
        role: 'Backend Developer',
        model: 'claude-sonnet-4',
        adapter_id: 'claude-code',
        lane: 'code',
        sandbox_profile: 'workspace-write',
        routing_reason: 'coding task with file system access',
        verify_status: 'pending',
        status: 'working',
      },
      {
        role: 'QA / Reviewer',
        model: 'claude-opus-4',
        routing_reason: 'code review requires deep analysis',
        status: 'queued',
      },
    ]);

    expect(report).not.toBeNull();

    // Verify report contents
    expect(report!.done).toContain('Design System');
    expect(report!.done).toContain('Milestone: Design System Ready');
    expect(report!.doing).toContain('Backend API');
    expect(report!.doing).toContain('Milestone: API MVP');
    expect(report!.delegations).toHaveLength(2);
    expect(report!.delegations[0].routing_reason).toBe('coding task with file system access');
    expect(report!.next_steps).toEqual(['Implement post CRUD API', 'Add markdown rendering']);

    // Render as markdown
    const md = renderProjectReport(report!);
    expect(md).toContain('## Project Status: Executing');
    expect(md).toContain('[x] Design System');
    expect(md).toContain('[>] Backend API');
    expect(md).toContain('claude-sonnet-4');
    expect(md).toContain('via claude-code');
    expect(md).toContain('lane: code');
    expect(md).toContain('coding task with file system access');
    expect(md).toContain('verify: pending');
    expect(md).toContain('code review requires deep analysis');

    // Compact progress update
    const compact = renderProgressUpdate(report!);
    expect(compact).toContain('**Status:** Executing');
    expect(compact).toContain('**Done:** Design System');
    expect(compact).toContain('**Doing:** Backend API');
    expect(compact).toContain('**Next:** Implement post CRUD API');
  });

  it('Phase 6: event bus integration for project events', () => {
    const events: ProgressEvent[] = [];
    on(e => events.push(e));

    // Emit project-specific events
    emit({ type: 'project_mode_kickoff', chatId: 'chat-1', card: '## Project Mode\n...' });
    emit({ type: 'project_plan_updated', chatId: 'chat-1', projectId: 'proj-1' });
    emit({
      type: 'team_assignment',
      chatId: 'chat-1',
      projectId: 'proj-1',
      agentRole: 'Backend Developer',
      model: 'claude-sonnet-4',
      adapter: 'claude-code',
      routingReason: 'coding task',
    });
    emit({
      type: 'milestone_reached',
      chatId: 'chat-1',
      projectId: 'proj-1',
      milestoneLabel: 'Design System Ready',
    });
    emit({
      type: 'blocker_detected',
      chatId: 'chat-1',
      projectId: 'proj-1',
      description: 'Redis not provisioned',
    });
    emit({
      type: 'risk_detected',
      chatId: 'chat-1',
      projectId: 'proj-1',
      description: 'Complex migration risk',
    });
    emit({
      type: 'next_step_updated',
      chatId: 'chat-1',
      projectId: 'proj-1',
      summary: 'Implement API endpoints',
    });

    expect(events).toHaveLength(7);

    // Verify event formatting
    expect(formatProgressText(events[0])).toContain('Project Mode started');
    expect(formatProgressText(events[1])).toContain('Project plan updated');
    expect(formatProgressText(events[2])).toContain('Backend Developer');
    expect(formatProgressText(events[2])).toContain('claude-sonnet-4');
    expect(formatProgressText(events[2])).toContain('coding task');
    expect(formatProgressText(events[3])).toContain('Milestone reached: Design System Ready');
    expect(formatProgressText(events[4])).toContain('Blocker: Redis not provisioned');
    expect(formatProgressText(events[5])).toContain('Risk: Complex migration risk');
    expect(formatProgressText(events[6])).toContain('Next: Implement API endpoints');
  });

  it('Phase 7: full lifecycle from kickoff to completion', () => {
    // 1. Kickoff
    const projectId = initFromDecision(blogDecision);

    // 2. Execute through all phases
    applyActions(projectId, [
      { type: 'set_status', status: 'executing' },
      // Phase 1: Design
      { type: 'update_workstream', name: 'Design System', patch: { status: 'in_progress' } },
      { type: 'update_workstream', name: 'Design System', patch: { status: 'done' } },
      { type: 'update_milestone', milestone_id: 'ms-1', patch: { status: 'done' } },
      // Phase 2: Backend
      { type: 'update_workstream', name: 'Backend API', patch: { status: 'in_progress' } },
      { type: 'update_workstream', name: 'Backend API', patch: { status: 'done' } },
      { type: 'update_milestone', milestone_id: 'ms-2', patch: { status: 'done' } },
      // Phase 3: Frontend
      { type: 'update_workstream', name: 'Frontend', patch: { status: 'in_progress' } },
      { type: 'update_workstream', name: 'Frontend', patch: { status: 'done' } },
      { type: 'update_milestone', milestone_id: 'ms-3', patch: { status: 'done' } },
      // Phase 4: Deploy
      { type: 'update_workstream', name: 'Deployment', patch: { status: 'in_progress' } },
      { type: 'update_workstream', name: 'Deployment', patch: { status: 'done' } },
      { type: 'update_milestone', milestone_id: 'ms-4', patch: { status: 'done' } },
      // Complete
      { type: 'set_status', status: 'completed' },
      { type: 'set_next_steps', steps: [] },
    ]);

    const finalState = getProject(projectId)!;
    expect(finalState.status).toBe('completed');
    expect(finalState.workstreams.every(w => w.status === 'done')).toBe(true);
    expect(finalState.milestones.every(m => m.status === 'done')).toBe(true);

    // Final report
    const report = generateReport(projectId);
    expect(report!.done).toHaveLength(8); // 4 workstreams + 4 milestones
    expect(report!.doing).toHaveLength(0);
    expect(report!.blocked).toHaveLength(0);

    const md = renderProjectReport(report!);
    expect(md).toContain('## Project Status: Completed');
    expect(md).toContain('[x] Design System');
    expect(md).toContain('[x] Backend API');
    expect(md).toContain('[x] Frontend');
    expect(md).toContain('[x] Deployment');
  });

  it('delegation report renders routing rationale standalone', () => {
    const md = renderDelegationReport([
      {
        role: 'PM / Planner',
        model: 'claude-opus-4',
        routing_reason: 'complex planning requires high-capability model',
        status: 'done',
      },
      {
        role: 'Frontend Developer',
        model: 'claude-sonnet-4',
        adapter_id: 'claude-code',
        lane: 'code',
        routing_reason: 'coding task',
        verify_status: 'passed',
        status: 'done',
      },
      {
        role: 'QA / Reviewer',
        model: 'claude-opus-4',
        routing_reason: 'review needs deep analysis',
        verify_status: 'passed',
        status: 'done',
      },
    ]);

    expect(md).toContain('### Delegation');
    expect(md).toContain('PM / Planner');
    expect(md).toContain('complex planning requires high-capability model');
    expect(md).toContain('Frontend Developer');
    expect(md).toContain('via claude-code');
    expect(md).toContain('lane: code');
    expect(md).toContain('QA / Reviewer');
    expect(md).toContain('review needs deep analysis');
  });
});
