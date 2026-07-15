import { describe, it, expect } from 'vitest';
import { renderProjectReport, renderDelegationReport, renderProgressUpdate } from './renderer.js';
import type { ProjectReport, DelegationEntry } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleReport: ProjectReport = {
  project_id: 'proj-1',
  goal: 'Build a personal blog website',
  status: 'executing',
  team: [
    { role: 'Architect', responsibility: 'Design', model: 'claude-opus', status: 'done' },
    { role: 'Developer', responsibility: 'Code', model: 'claude-sonnet', adapter_id: 'claude-code', status: 'working' },
    { role: 'QA', responsibility: 'Test', status: 'idle' },
  ],
  done: ['Design', 'Milestone: Design Complete'],
  doing: ['Backend', 'Milestone: MVP'],
  blocked: ['Frontend', '[critical] Missing API credentials'],
  risks: ['[high] Complex integration with legacy system'],
  next_steps: ['Complete backend API', 'Provision database'],
  delegations: [
    {
      role: 'Developer',
      model: 'claude-sonnet-4',
      adapter_id: 'claude-code',
      lane: 'code',
      routing_reason: 'coding task requires file access',
      verify_status: 'pending',
      status: 'working',
    },
    {
      role: 'Reviewer',
      model: 'claude-opus-4',
      routing_reason: 'code review requires deep analysis',
      status: 'queued',
    },
  ],
  updated_at: Date.now(),
};

const emptyReport: ProjectReport = {
  project_id: 'proj-2',
  goal: 'Simple task',
  status: 'planning',
  team: [],
  done: [],
  doing: [],
  blocked: [],
  risks: [],
  next_steps: [],
  delegations: [],
  updated_at: Date.now(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-mode/renderer', () => {
  describe('renderProjectReport', () => {
    it('renders all sections for a full report', () => {
      const md = renderProjectReport(sampleReport);
      expect(md).toContain('## Project Status: Executing');
      expect(md).toContain('**Goal:** Build a personal blog website');

      // Team
      expect(md).toContain('### Team');
      expect(md).toContain('**Architect**');
      expect(md).toContain('claude-opus');
      expect(md).toContain('[x]'); // done architect
      expect(md).toContain('**Developer**');
      expect(md).toContain('[>]'); // working developer

      // Done
      expect(md).toContain('### Done');
      expect(md).toContain('[x] Design');

      // In Progress
      expect(md).toContain('### In Progress');
      expect(md).toContain('[>] Backend');

      // Blocked
      expect(md).toContain('### Blocked');
      expect(md).toContain('[!] Frontend');
      expect(md).toContain('Missing API credentials');

      // Risks
      expect(md).toContain('### Risks');
      expect(md).toContain('Complex integration');

      // Delegation
      expect(md).toContain('### Delegation');
      expect(md).toContain('claude-sonnet-4');
      expect(md).toContain('via claude-code');
      expect(md).toContain('lane: code');
      expect(md).toContain('coding task requires file access');
      expect(md).toContain('verify: pending');

      // Next
      expect(md).toContain('### Next Steps');
      expect(md).toContain('Complete backend API');
    });

    it('renders minimal report without empty sections', () => {
      const md = renderProjectReport(emptyReport);
      expect(md).toContain('## Project Status: Planning');
      expect(md).toContain('**Goal:** Simple task');
      expect(md).not.toContain('### Team');
      expect(md).not.toContain('### Done');
      expect(md).not.toContain('### In Progress');
      expect(md).not.toContain('### Blocked');
      expect(md).not.toContain('### Risks');
      expect(md).not.toContain('### Delegation');
      expect(md).not.toContain('### Next Steps');
    });
  });

  describe('renderDelegationReport', () => {
    it('renders delegation entries with routing rationale', () => {
      const delegations: DelegationEntry[] = [
        {
          role: 'Coder',
          model: 'gpt-4.1',
          adapter_id: 'codex',
          lane: 'code',
          routing_reason: 'fast coding model',
          status: 'working',
        },
      ];
      const md = renderDelegationReport(delegations);
      expect(md).toContain('### Delegation');
      expect(md).toContain('**Coder**');
      expect(md).toContain('gpt-4.1');
      expect(md).toContain('via codex');
      expect(md).toContain('fast coding model');
    });

    it('returns placeholder for empty delegations', () => {
      const md = renderDelegationReport([]);
      expect(md).toContain('No active delegations');
    });
  });

  describe('renderProgressUpdate', () => {
    it('renders compact progress with all categories', () => {
      const md = renderProgressUpdate(sampleReport);
      expect(md).toContain('**Status:** Executing');
      expect(md).toContain('**Done:** Design');
      expect(md).toContain('**Doing:** Backend');
      expect(md).toContain('**Blocked:**');
      expect(md).toContain('**Next:** Complete backend API');
    });

    it('renders minimal progress', () => {
      const md = renderProgressUpdate(emptyReport);
      expect(md).toContain('**Status:** Planning');
      expect(md).not.toContain('**Done:**');
      expect(md).not.toContain('**Doing:**');
    });
  });
});
