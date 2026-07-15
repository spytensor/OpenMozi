import type { LLMClient, ChatMessage } from '../core/llm.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:project-mode' });

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ProjectModeWorkstream {
  name: string;
  description: string;
}

export interface ProjectModeTeamRole {
  role: string;
  responsibility: string;
}

export interface ProjectModeMilestone {
  label: string;
  criteria: string;
}

/** Structured decision object produced by the LLM evaluator. */
export interface ProjectModeDecision {
  enabled: boolean;
  reason: string;
  goal: string;
  workstreams: ProjectModeWorkstream[];
  team_roles: ProjectModeTeamRole[];
  model_strategy: string;
  milestones: ProjectModeMilestone[];
  reporting_mode: string;
  clarifications_needed: string[];
}

/** Rendered kickoff card sections for user-visible output. */
export interface ProjectModeKickoffCard {
  goal: string;
  plan: string;
  team: string;
  model_strategy: string;
  milestones: string;
  open_questions: string;
  raw: ProjectModeDecision;
}

// ---------------------------------------------------------------------------
// Evaluator - asks the LLM whether a request warrants Project Mode
// ---------------------------------------------------------------------------

const EVALUATOR_SYSTEM_PROMPT = `You are a project-mode evaluator. Given a user request, decide whether it requires multi-phase project execution or is a simple request that can be handled in a single turn.

Respond ONLY with a JSON object (no markdown fences, no extra text) matching this schema:
{
  "enabled": boolean,
  "reason": "short explanation of why project mode is or isn't needed",
  "goal": "clear goal statement (empty string if disabled)",
  "workstreams": [{"name": "...", "description": "..."}],
  "team_roles": [{"role": "...", "responsibility": "..."}],
  "model_strategy": "which model tiers to use and why (empty string if disabled)",
  "milestones": [{"label": "...", "criteria": "..."}],
  "reporting_mode": "how progress will be reported (empty string if disabled)",
  "clarifications_needed": ["questions for the user, if any"]
}

Guidelines:
- Enable project mode ONLY for requests that genuinely need multiple coordinated phases, such as: building a full feature across multiple files, large refactors, multi-step research with synthesis, setting up entire systems.
- Do NOT enable for: simple questions, single-file edits, quick lookups, explanations, small bug fixes, one-shot tasks.
- Keep workstreams, team_roles, and milestones concise (1-5 items each).
- If disabled, set arrays to empty and strings to empty.`;

/**
 * Ask the LLM whether a user request should enter Project Mode.
 * Returns a structured decision. Falls back to disabled on any error.
 */
export async function evaluateProjectMode(
  userMessage: string,
  client: LLMClient,
  opts?: { timeout_ms?: number },
): Promise<ProjectModeDecision> {
  const disabledFallback: ProjectModeDecision = {
    enabled: false,
    reason: 'Evaluation skipped or failed',
    goal: '',
    workstreams: [],
    team_roles: [],
    model_strategy: '',
    milestones: [],
    reporting_mode: '',
    clarifications_needed: [],
  };

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: EVALUATOR_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];

    const response = await client.chat(messages, {
      max_tokens: 1024,
      temperature: 0.2,
      timeout_ms: opts?.timeout_ms ?? 15_000,
    });

    const raw = response.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.enabled !== 'boolean') {
      logger.warn({ raw }, 'Project mode evaluator returned invalid enabled field');
      return disabledFallback;
    }

    return {
      enabled: parsed.enabled,
      reason: String(parsed.reason ?? ''),
      goal: String(parsed.goal ?? ''),
      workstreams: Array.isArray(parsed.workstreams)
        ? parsed.workstreams.map((w: Record<string, unknown>) => ({
            name: String(w.name ?? ''),
            description: String(w.description ?? ''),
          }))
        : [],
      team_roles: Array.isArray(parsed.team_roles)
        ? parsed.team_roles.map((r: Record<string, unknown>) => ({
            role: String(r.role ?? ''),
            responsibility: String(r.responsibility ?? ''),
          }))
        : [],
      model_strategy: String(parsed.model_strategy ?? ''),
      milestones: Array.isArray(parsed.milestones)
        ? parsed.milestones.map((m: Record<string, unknown>) => ({
            label: String(m.label ?? ''),
            criteria: String(m.criteria ?? ''),
          }))
        : [],
      reporting_mode: String(parsed.reporting_mode ?? ''),
      clarifications_needed: Array.isArray(parsed.clarifications_needed)
        ? parsed.clarifications_needed.map(String)
        : [],
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Project mode evaluation failed; defaulting to disabled',
    );
    return disabledFallback;
  }
}

// ---------------------------------------------------------------------------
// Kickoff card renderer
// ---------------------------------------------------------------------------

/**
 * Render a ProjectModeDecision into a user-visible kickoff card.
 * Only call this when decision.enabled is true.
 */
export function renderKickoffCard(decision: ProjectModeDecision): ProjectModeKickoffCard {
  const plan = decision.workstreams.length > 0
    ? decision.workstreams.map((w, i) => `${i + 1}. **${w.name}** \u2014 ${w.description}`).join('\n')
    : '_No workstreams defined._';

  const team = decision.team_roles.length > 0
    ? decision.team_roles.map(r => `- **${r.role}**: ${r.responsibility}`).join('\n')
    : '_Default team._';

  const milestones = decision.milestones.length > 0
    ? decision.milestones.map((m, i) => `${i + 1}. **${m.label}** \u2014 ${m.criteria}`).join('\n')
    : '_Milestones will be determined during execution._';

  const openQuestions = decision.clarifications_needed.length > 0
    ? decision.clarifications_needed.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '_None \u2014 ready to proceed._';

  return {
    goal: decision.goal,
    plan,
    team,
    model_strategy: decision.model_strategy || '_Default model strategy._',
    milestones,
    open_questions: openQuestions,
    raw: decision,
  };
}

/**
 * Format a kickoff card as a markdown string for channel output.
 */
export function formatKickoffCardMarkdown(card: ProjectModeKickoffCard): string {
  return [
    '## Project Mode Activated',
    '',
    '### Goal',
    card.goal,
    '',
    '### Plan',
    card.plan,
    '',
    '### Team',
    card.team,
    '',
    '### Model Strategy',
    card.model_strategy,
    '',
    '### Milestones',
    card.milestones,
    '',
    '### Open Questions',
    card.open_questions,
  ].join('\n');
}

/**
 * Build a system prompt directive to inject when project mode is active.
 *
 * This directive is the ONLY thing that drives project execution.
 * There is no external "execution engine" — the Brain drives the entire
 * project through its normal tool loop with a higher step budget.
 */
export function buildProjectModeDirective(card: ProjectModeKickoffCard): string {
  const workstreamList = card.raw.workstreams
    .map((ws, i) => `  ${i + 1}. **${ws.name}**: ${ws.description}`)
    .join('\n');

  return [
    '[PROJECT MODE — ACTIVE]',
    '',
    `**Goal**: ${card.goal}`,
    '',
    '**Workstreams** (execute IN ORDER, one by one):',
    workstreamList,
    '',
    '**Execution rules:**',
    '- Work through each workstream sequentially. Do NOT skip ahead.',
    '- For each workstream: use the appropriate tools (web_search, web_fetch, shell_exec, etc.) to actually DO the work. Do NOT just describe what you would do.',
    '- After completing each workstream, call `send_progress_report` with a summary of what you accomplished and what comes next.',
    '- After all workstreams are done, write your final comprehensive response to the user.',
    '- If a workstream fails (e.g., search returns no results), report the failure in the progress report and adapt your approach for subsequent workstreams.',
    '- You have an extended tool budget for this project. Use as many tool calls as needed.',
  ].join('\n');
}
