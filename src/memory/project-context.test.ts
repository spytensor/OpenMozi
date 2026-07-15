import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  saveProjectFact,
  getProjectFacts,
  deleteProjectFact,
  getProjectSection,
} from './project-context.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/project-context', () => {
  it('saves and retrieves project facts', () => {
    saveProjectFact('tech_stack', 'React + TypeScript', 'fact');
    const facts = getProjectFacts('fact');
    expect(facts.some(f => f.key === 'tech_stack' && f.value === 'React + TypeScript')).toBe(true);
  });

  it('retrieves all categories when no filter specified', () => {
    saveProjectFact('framework', 'Fastify', 'fact');
    saveProjectFact('package_manager', 'pnpm', 'preference');
    saveProjectFact('db_choice', 'SQLite over PostgreSQL', 'decision');
    saveProjectFact('orm_lesson', 'Avoid ORMs for simple queries', 'lesson');

    const all = getProjectFacts();
    expect(all.some(f => f.key === 'framework')).toBe(true);
    expect(all.some(f => f.key === 'package_manager')).toBe(true);
    expect(all.some(f => f.key === 'db_choice')).toBe(true);
    expect(all.some(f => f.key === 'orm_lesson')).toBe(true);
  });

  it('isolates facts by tenant', () => {
    saveProjectFact('tenant_fact', 'value_a', 'fact', undefined, 'tenant_a');
    saveProjectFact('tenant_fact', 'value_b', 'fact', undefined, 'tenant_b');

    const factsA = getProjectFacts('fact', 'tenant_a');
    const factsB = getProjectFacts('fact', 'tenant_b');

    const valA = factsA.find(f => f.key === 'tenant_fact');
    const valB = factsB.find(f => f.key === 'tenant_fact');
    expect(valA?.value).toBe('value_a');
    expect(valB?.value).toBe('value_b');
  });

  it('upserts on duplicate key (same category)', () => {
    saveProjectFact('entry_point', 'src/main.ts', 'fact');
    saveProjectFact('entry_point', 'src/index.ts', 'fact');

    const facts = getProjectFacts('fact');
    const entries = facts.filter(f => f.key === 'entry_point');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('src/index.ts');
  });

  it('deletes a project fact', () => {
    saveProjectFact('to_delete', 'temporary', 'fact');
    expect(getProjectFacts('fact').some(f => f.key === 'to_delete')).toBe(true);

    deleteProjectFact('to_delete', 'fact');
    expect(getProjectFacts('fact').some(f => f.key === 'to_delete')).toBe(false);
  });

  it('getProjectSection returns empty string when no facts exist', () => {
    const section = getProjectSection('empty_tenant');
    expect(section).toBe('');
  });

  it('getProjectSection formats facts into grouped sections', () => {
    const tid = 'section_test';
    saveProjectFact('runtime', 'Node.js 22', 'fact', undefined, tid);
    saveProjectFact('coding_style', 'strict TypeScript', 'preference', undefined, tid);
    saveProjectFact('api_pattern', 'REST over GraphQL', 'decision', undefined, tid);
    saveProjectFact('perf_lesson', 'Batch DB writes', 'lesson', undefined, tid);

    const section = getProjectSection(tid);
    expect(section).toContain('## Project Knowledge');
    expect(section).toContain('### Architecture');
    expect(section).toContain('[fact] runtime: Node.js 22');
    expect(section).toContain('### Conventions');
    expect(section).toContain('[preference] coding_style: strict TypeScript');
    expect(section).toContain('### Decisions');
    expect(section).toContain('[decision] api_pattern: REST over GraphQL');
    expect(section).toContain('### Lessons');
    expect(section).toContain('[lesson] perf_lesson: Batch DB writes');
  });

  it('getProjectSection omits empty subsections', () => {
    const tid = 'partial_section';
    saveProjectFact('only_fact', 'value', 'fact', undefined, tid);

    const section = getProjectSection(tid);
    expect(section).toContain('### Architecture');
    expect(section).not.toContain('### Conventions');
    expect(section).not.toContain('### Decisions');
    expect(section).not.toContain('### Lessons');
  });
});
