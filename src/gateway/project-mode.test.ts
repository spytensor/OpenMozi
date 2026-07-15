import { describe, expect, it } from 'vitest';
import type { ProjectModeDecision } from './project-mode.js';
import { renderKickoffCard, formatKickoffCardMarkdown, buildProjectModeDirective, evaluateProjectMode } from './project-mode.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const enabledDecision: ProjectModeDecision = {
  enabled: true,
  reason: 'Multi-phase feature spanning several files and subsystems',
  goal: 'Build a complete authentication system with OAuth2, session management, and RBAC',
  workstreams: [
    { name: 'OAuth2 Integration', description: 'Implement OAuth2 provider with Google and GitHub' },
    { name: 'Session Management', description: 'Add session store with Redis backing' },
    { name: 'RBAC', description: 'Role-based access control with permission gates' },
  ],
  team_roles: [
    { role: 'Architect', responsibility: 'Design API contracts and data models' },
    { role: 'Implementer', responsibility: 'Write and test the code' },
  ],
  model_strategy: 'Use high-capability model for architecture, fast model for implementation',
  milestones: [
    { label: 'OAuth2 MVP', criteria: 'Google login flow works end-to-end' },
    { label: 'Session Store', criteria: 'Sessions persist across server restarts' },
    { label: 'RBAC Gates', criteria: 'Protected routes reject unauthorized users' },
  ],
  reporting_mode: 'Report after each milestone completion',
  clarifications_needed: ['Which OAuth2 providers are required?', 'Is Redis already available?'],
};

const disabledDecision: ProjectModeDecision = {
  enabled: false,
  reason: 'Simple single-turn request',
  goal: '',
  workstreams: [],
  team_roles: [],
  model_strategy: '',
  milestones: [],
  reporting_mode: '',
  clarifications_needed: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateway/project-mode', () => {
  describe('renderKickoffCard', () => {
    it('renders a full kickoff card from an enabled decision', () => {
      const card = renderKickoffCard(enabledDecision);
      expect(card.goal).toBe(enabledDecision.goal);
      expect(card.plan).toContain('OAuth2 Integration');
      expect(card.plan).toContain('Session Management');
      expect(card.plan).toContain('RBAC');
      expect(card.team).toContain('Architect');
      expect(card.team).toContain('Implementer');
      expect(card.model_strategy).toContain('high-capability');
      expect(card.milestones).toContain('OAuth2 MVP');
      expect(card.milestones).toContain('Session Store');
      expect(card.open_questions).toContain('OAuth2 providers');
      expect(card.open_questions).toContain('Redis');
      expect(card.raw).toBe(enabledDecision);
    });

    it('renders fallback text for an empty enabled decision', () => {
      const emptyEnabled: ProjectModeDecision = {
        ...enabledDecision,
        workstreams: [],
        team_roles: [],
        milestones: [],
        clarifications_needed: [],
        model_strategy: '',
      };
      const card = renderKickoffCard(emptyEnabled);
      expect(card.plan).toContain('No workstreams defined');
      expect(card.team).toContain('Default team');
      expect(card.milestones).toContain('determined during execution');
      expect(card.open_questions).toContain('ready to proceed');
      expect(card.model_strategy).toContain('Default model strategy');
    });
  });

  describe('formatKickoffCardMarkdown', () => {
    it('produces markdown with all required sections', () => {
      const card = renderKickoffCard(enabledDecision);
      const md = formatKickoffCardMarkdown(card);
      expect(md).toContain('## Project Mode Activated');
      expect(md).toContain('### Goal');
      expect(md).toContain('### Plan');
      expect(md).toContain('### Team');
      expect(md).toContain('### Model Strategy');
      expect(md).toContain('### Milestones');
      expect(md).toContain('### Open Questions');
      expect(md).toContain(enabledDecision.goal);
    });
  });

  describe('buildProjectModeDirective', () => {
    it('builds a system prompt directive with project context', () => {
      const card = renderKickoffCard(enabledDecision);
      const directive = buildProjectModeDirective(card);
      expect(directive).toContain('[PROJECT MODE');
      expect(directive).toContain('ACTIVE');
      expect(directive).toContain(enabledDecision.goal);
      expect(directive).toContain('Work through each workstream sequentially');
      expect(directive).toContain('send_progress_report');
    });

    it('omits Open Questions line when none are needed', () => {
      const noQuestions: ProjectModeDecision = {
        ...enabledDecision,
        clarifications_needed: [],
      };
      const card = renderKickoffCard(noQuestions);
      const directive = buildProjectModeDirective(card);
      expect(directive).not.toContain('Open Questions');
    });
  });

  describe('evaluateProjectMode', () => {
    it('returns disabled fallback when client throws', async () => {
      const failClient = {
        chat: async () => { throw new Error('network error'); },
      } as any;
      const result = await evaluateProjectMode('build me a spaceship', failClient);
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('skipped or failed');
    });

    it('returns disabled fallback when client returns invalid JSON', async () => {
      const badClient = {
        chat: async () => ({ content: 'not json at all', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test', stop_reason: 'stop' }),
      } as any;
      const result = await evaluateProjectMode('build me a spaceship', badClient);
      expect(result.enabled).toBe(false);
    });

    it('returns disabled fallback when enabled field is not boolean', async () => {
      const badClient = {
        chat: async () => ({ content: JSON.stringify({ enabled: 'yes', reason: 'bad' }), usage: { input_tokens: 0, output_tokens: 0 }, model: 'test', stop_reason: 'stop' }),
      } as any;
      const result = await evaluateProjectMode('build me a spaceship', badClient);
      expect(result.enabled).toBe(false);
    });

    it('parses a valid enabled response from the LLM', async () => {
      const mockResponse = JSON.stringify(enabledDecision);
      const goodClient = {
        chat: async () => ({ content: mockResponse, usage: { input_tokens: 100, output_tokens: 200 }, model: 'test', stop_reason: 'stop' }),
      } as any;
      const result = await evaluateProjectMode('Build a complete auth system with OAuth2, sessions, and RBAC', goodClient);
      expect(result.enabled).toBe(true);
      expect(result.goal).toBe(enabledDecision.goal);
      expect(result.workstreams).toHaveLength(3);
      expect(result.team_roles).toHaveLength(2);
      expect(result.milestones).toHaveLength(3);
      expect(result.clarifications_needed).toHaveLength(2);
    });

    it('parses a valid disabled response from the LLM', async () => {
      const mockResponse = JSON.stringify(disabledDecision);
      const goodClient = {
        chat: async () => ({ content: mockResponse, usage: { input_tokens: 50, output_tokens: 50 }, model: 'test', stop_reason: 'stop' }),
      } as any;
      const result = await evaluateProjectMode('What time is it?', goodClient);
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('Simple single-turn request');
      expect(result.workstreams).toHaveLength(0);
    });

    it('strips markdown code fences from LLM response', async () => {
      const wrapped = '```json\n' + JSON.stringify(disabledDecision) + '\n```';
      const client = {
        chat: async () => ({ content: wrapped, usage: { input_tokens: 50, output_tokens: 50 }, model: 'test', stop_reason: 'stop' }),
      } as any;
      const result = await evaluateProjectMode('hello', client);
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('Simple single-turn request');
    });
  });
});
