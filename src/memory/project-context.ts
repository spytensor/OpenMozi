import pino from 'pino';
import { saveFact, getFacts, deleteFact, type FactCategory, type MemoryFact } from './long-term.js';
import type { LLMClient, ChatMessage } from '../core/llm.js';

const logger = pino({ name: 'mozi:memory:project-context' });

/** Global scope for project-level facts — shared across all sessions */
const PROJECT_CHAT_ID = '__project__';

/**
 * Save a project-level fact (shared across all sessions).
 */
export function saveProjectFact(
  key: string,
  value: string,
  category: FactCategory = 'fact',
  source?: string,
  tenantId = 'default',
): void {
  saveFact(PROJECT_CHAT_ID, category, key, value, source, tenantId);
}

/**
 * Get project-level facts, optionally filtered by category.
 */
export function getProjectFacts(
  category?: FactCategory,
  tenantId = 'default',
): MemoryFact[] {
  return getFacts(PROJECT_CHAT_ID, category, tenantId);
}

/**
 * Delete a project-level fact.
 */
export function deleteProjectFact(
  key: string,
  category: FactCategory,
  tenantId = 'default',
): void {
  deleteFact(PROJECT_CHAT_ID, category, key, tenantId);
}

/**
 * Build the project knowledge section for injection into the system prompt.
 * Returns empty string if no project facts exist.
 */
export function getProjectSection(tenantId = 'default'): string {
  const facts = getProjectFacts(undefined, tenantId);
  if (facts.length === 0) return '';

  const groups: Record<string, MemoryFact[]> = {
    architecture: [],
    conventions: [],
    decisions: [],
    lessons: [],
  };

  for (const fact of facts) {
    switch (fact.category) {
      case 'fact':
        groups.architecture.push(fact);
        break;
      case 'preference':
        groups.conventions.push(fact);
        break;
      case 'decision':
        groups.decisions.push(fact);
        break;
      case 'lesson':
        groups.lessons.push(fact);
        break;
    }
  }

  const sections: string[] = ['## Project Knowledge'];

  if (groups.architecture.length > 0) {
    sections.push('### Architecture');
    for (const f of groups.architecture) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.conventions.length > 0) {
    sections.push('### Conventions');
    for (const f of groups.conventions) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.decisions.length > 0) {
    sections.push('### Decisions');
    for (const f of groups.decisions) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.lessons.length > 0) {
    sections.push('### Lessons');
    for (const f of groups.lessons) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  return sections.join('\n');
}

const PROJECT_EXTRACTION_PROMPT = `Extract project-level knowledge from this conversation turn.
Look for information about:
- Tech stack / frameworks (e.g. "this project uses React", "we use PostgreSQL")
- Architecture patterns (e.g. "the API follows REST", "we use a monorepo")
- Project conventions (e.g. "always use pnpm", "tests go in __tests__")
- Key file paths (e.g. "the main entry is src/index.ts")
- Architectural decisions (e.g. "we chose SQLite over PostgreSQL for simplicity")
- Project lessons learned (e.g. "avoid using ORM X because of performance issues")

Classify each item into one of these categories:
- "fact": project architecture, tech stack, key files
- "preference": code conventions, tool preferences
- "decision": architectural decisions
- "lesson": project-specific lessons learned

Output JSON only: {"items":[{"key":"short_key","value":"description","category":"fact|preference|decision|lesson"}]}
Empty array if no project-level knowledge found.
Only extract information clearly about the PROJECT, not user personal preferences.`;

/**
 * Use LLM to extract project-level knowledge from a conversation turn.
 * Returns the number of extracted facts.
 */
export async function extractProjectKnowledge(
  userMessage: string,
  assistantResponse: string,
  client: LLMClient,
  tenantId = 'default',
): Promise<number> {
  if (!client || typeof client.chat !== 'function') {
    return 0;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: PROJECT_EXTRACTION_PROMPT },
    {
      role: 'user',
      content: `User message:\n${userMessage}\n\nAssistant response:\n${assistantResponse}`,
    },
  ];

  let response;
  try {
    response = await client.chat(messages, { max_tokens: 300, temperature: 0 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, 'Project knowledge extraction LLM call failed');
    return 0;
  }

  const content = response.content.trim();
  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    logger.debug('Project knowledge extraction returned non-JSON');
    return 0;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  } catch {
    logger.debug('Project knowledge extraction JSON parse failed');
    return 0;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const validCategories = new Set<string>(['fact', 'preference', 'decision', 'lesson']);
  let count = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    const value = typeof rec.value === 'string' ? rec.value.trim() : '';
    const category = typeof rec.category === 'string' ? rec.category.trim() : '';

    if (!key || !value || !validCategories.has(category)) continue;

    saveProjectFact(key, value, category as FactCategory, 'project_extraction', tenantId);
    count++;
  }

  if (count > 0) {
    logger.info({ count, tenantId }, 'Extracted project-level knowledge');
  }

  return count;
}
