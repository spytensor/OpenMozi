/**
 * Project Mode — renders project reports and delegation info
 * as user-visible markdown (#181 + #182).
 */

import type { ProjectReport, DelegationEntry, ProjectTeamMember } from './types.js';

// ---------------------------------------------------------------------------
// Full project report
// ---------------------------------------------------------------------------

/**
 * Render a ProjectReport as user-visible markdown.
 */
export function renderProjectReport(report: ProjectReport): string {
  const sections: string[] = [
    `## Project Status: ${formatStatus(report.status)}`,
    '',
    `**Goal:** ${report.goal}`,
  ];

  // Team
  if (report.team.length > 0) {
    sections.push('', '### Team');
    for (const m of report.team) {
      sections.push(formatTeamMember(m));
    }
  }

  // Done
  if (report.done.length > 0) {
    sections.push('', '### Done');
    for (const item of report.done) {
      sections.push(`- [x] ${item}`);
    }
  }

  // Doing
  if (report.doing.length > 0) {
    sections.push('', '### In Progress');
    for (const item of report.doing) {
      sections.push(`- [>] ${item}`);
    }
  }

  // Blocked
  if (report.blocked.length > 0) {
    sections.push('', '### Blocked');
    for (const item of report.blocked) {
      sections.push(`- [!] ${item}`);
    }
  }

  // Risks
  if (report.risks.length > 0) {
    sections.push('', '### Risks');
    for (const item of report.risks) {
      sections.push(`- ${item}`);
    }
  }

  // Delegation / routing rationale
  if (report.delegations.length > 0) {
    sections.push('', '### Delegation');
    for (const d of report.delegations) {
      sections.push(formatDelegationEntry(d));
    }
  }

  // Next steps
  if (report.next_steps.length > 0) {
    sections.push('', '### Next Steps');
    for (const step of report.next_steps) {
      sections.push(`- ${step}`);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Delegation-only report (#182)
// ---------------------------------------------------------------------------

/**
 * Render delegation entries as a standalone section.
 */
export function renderDelegationReport(delegations: DelegationEntry[]): string {
  if (delegations.length === 0) return '_No active delegations._';

  const lines: string[] = ['### Delegation'];
  for (const d of delegations) {
    lines.push(formatDelegationEntry(d));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compact progress update (#181)
// ---------------------------------------------------------------------------

/**
 * Render a compact progress update for mid-execution reporting.
 */
export function renderProgressUpdate(report: ProjectReport): string {
  const parts: string[] = [];

  parts.push(`**Status:** ${formatStatus(report.status)}`);

  if (report.done.length > 0) {
    parts.push(`**Done:** ${report.done.join(', ')}`);
  }
  if (report.doing.length > 0) {
    parts.push(`**Doing:** ${report.doing.join(', ')}`);
  }
  if (report.blocked.length > 0) {
    parts.push(`**Blocked:** ${report.blocked.join(', ')}`);
  }
  if (report.next_steps.length > 0) {
    parts.push(`**Next:** ${report.next_steps[0]}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStatus(status: string): string {
  switch (status) {
    case 'planning': return 'Planning';
    case 'executing': return 'Executing';
    case 'blocked': return 'Blocked';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    default: return status;
  }
}

function formatTeamMember(m: ProjectTeamMember): string {
  const parts = [`- **${m.role}**`];
  if (m.model) parts.push(`model: ${m.model}`);
  if (m.adapter_id) parts.push(`worker: ${m.adapter_id}`);
  const statusIcon = m.status === 'done' ? '[x]'
    : m.status === 'working' ? '[>]'
    : m.status === 'failed' ? '[!]'
    : '[ ]';
  parts.push(statusIcon);
  return parts.join(' | ');
}

function formatDelegationEntry(d: DelegationEntry): string {
  const parts = [`- **${d.role}**`];
  if (d.model) parts.push(d.model);
  if (d.adapter_id) parts.push(`via ${d.adapter_id}`);
  if (d.lane) parts.push(`lane: ${d.lane}`);
  if (d.routing_reason) parts.push(`(${d.routing_reason})`);
  if (d.verify_status) parts.push(`verify: ${d.verify_status}`);
  if (d.blocker) parts.push(`BLOCKED: ${d.blocker}`);
  const statusIcon = d.status === 'done' ? '[x]'
    : d.status === 'working' ? '[>]'
    : d.status === 'failed' ? '[!]'
    : d.status === 'blocked' ? '[!]'
    : '[ ]';
  return `${parts.join(' -> ')} ${statusIcon}`;
}
