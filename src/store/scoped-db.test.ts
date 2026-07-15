/**
 * Tests for ScopedDb — tenant-scoped database wrapper (#235)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from './db.js';
import { ScopedDb, ScopedStatement } from './scoped-db.js';

let tmpDir: string;

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS test_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL
    )
  `);
}

function insertItem(tenantId: string, id: string, name: string): void {
  getDb()
    .prepare('INSERT INTO test_items (id, tenant_id, name) VALUES (?, ?, ?)')
    .run(id, tenantId, name);
}

// ---------------------------------------------------------------------------
// ScopedDb.all()
// ---------------------------------------------------------------------------

describe('ScopedDb.all()', () => {
  it('returns only rows belonging to the scoped tenant', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha One');
    insertItem('tenant-a', 'a2', 'Alpha Two');
    insertItem('tenant-b', 'b1', 'Beta One');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const rows = scoped.all<{ id: string; name: string }>(
      'SELECT id, name FROM test_items WHERE tenant_id = $tenant_id',
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('returns empty array when no rows match the tenant', () => {
    createTestTable();
    insertItem('tenant-b', 'b1', 'Beta One');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const rows = scoped.all(
      'SELECT * FROM test_items WHERE tenant_id = $tenant_id',
    );
    expect(rows).toHaveLength(0);
  });

  it('passes additional named params correctly', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha One');
    insertItem('tenant-a', 'a2', 'Alpha Two');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const rows = scoped.all<{ id: string }>(
      'SELECT id FROM test_items WHERE tenant_id = $tenant_id AND name = $name',
      { name: 'Alpha One' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// ScopedDb.get()
// ---------------------------------------------------------------------------

describe('ScopedDb.get()', () => {
  it('returns the matching row for the correct tenant', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha One');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const row = scoped.get<{ id: string; name: string }>(
      'SELECT id, name FROM test_items WHERE tenant_id = $tenant_id AND id = $id',
      { id: 'a1' },
    );
    expect(row).toBeDefined();
    expect(row!.name).toBe('Alpha One');
  });

  it('returns undefined when the row belongs to a different tenant', () => {
    createTestTable();
    insertItem('tenant-b', 'b1', 'Beta One');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const row = scoped.get(
      'SELECT * FROM test_items WHERE tenant_id = $tenant_id AND id = $id',
      { id: 'b1' },
    );
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ScopedDb.run()
// ---------------------------------------------------------------------------

describe('ScopedDb.run()', () => {
  it('inserts a row with tenant_id injected', () => {
    createTestTable();
    const scoped = new ScopedDb(getDb(), 'tenant-a');
    scoped.run(
      'INSERT INTO test_items (id, tenant_id, name) VALUES ($id, $tenant_id, $name)',
      { id: 'a1', name: 'Alpha One' },
    );

    const row = getDb()
      .prepare('SELECT * FROM test_items WHERE id = ?')
      .get('a1') as { tenant_id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.tenant_id).toBe('tenant-a');
    expect(row!.name).toBe('Alpha One');
  });

  it('delete is scoped to tenant', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha One');
    insertItem('tenant-b', 'b1', 'Beta One');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    scoped.run(
      'DELETE FROM test_items WHERE tenant_id = $tenant_id AND id = $id',
      { id: 'a1' },
    );

    const remaining = getDb()
      .prepare('SELECT COUNT(*) as cnt FROM test_items')
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(1);

    const bRow = getDb()
      .prepare('SELECT * FROM test_items WHERE id = ?')
      .get('b1');
    expect(bRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('Cross-tenant isolation', () => {
  it('tenant A queries do not see tenant B data', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha');
    insertItem('tenant-b', 'b1', 'Beta');

    const scopedA = new ScopedDb(getDb(), 'tenant-a');
    const scopedB = new ScopedDb(getDb(), 'tenant-b');

    const aRows = scopedA.all('SELECT * FROM test_items WHERE tenant_id = $tenant_id');
    const bRows = scopedB.all('SELECT * FROM test_items WHERE tenant_id = $tenant_id');

    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect((aRows[0] as { id: string }).id).toBe('a1');
    expect((bRows[0] as { id: string }).id).toBe('b1');
  });
});

// ---------------------------------------------------------------------------
// ScopedDb.withTenant()
// ---------------------------------------------------------------------------

describe('ScopedDb.withTenant()', () => {
  it('creates a new ScopedDb with the specified tenant', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha');
    insertItem('tenant-b', 'b1', 'Beta');

    const scopedA = new ScopedDb(getDb(), 'tenant-a');
    const scopedB = scopedA.withTenant('tenant-b');

    expect(scopedB.tenantId).toBe('tenant-b');
    const rows = scopedB.all('SELECT * FROM test_items WHERE tenant_id = $tenant_id');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('b1');
  });

  it('does not mutate the original ScopedDb instance', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha');

    const scopedA = new ScopedDb(getDb(), 'tenant-a');
    scopedA.withTenant('tenant-b');
    expect(scopedA.tenantId).toBe('tenant-a');
  });
});

// ---------------------------------------------------------------------------
// ScopedDb.raw
// ---------------------------------------------------------------------------

describe('ScopedDb.raw', () => {
  it('exposes the underlying database for cross-tenant admin operations', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha');
    insertItem('tenant-b', 'b1', 'Beta');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const allRows = scoped.raw
      .prepare('SELECT COUNT(*) as cnt FROM test_items')
      .get() as { cnt: number };
    expect(allRows.cnt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ScopedDb.prepare()
// ---------------------------------------------------------------------------

describe('ScopedDb.prepare()', () => {
  it('returns a ScopedStatement that auto-injects tenant_id', () => {
    createTestTable();
    insertItem('tenant-a', 'a1', 'Alpha');
    insertItem('tenant-b', 'b1', 'Beta');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const stmt = scoped.prepare('SELECT * FROM test_items WHERE tenant_id = $tenant_id');
    expect(stmt).toBeInstanceOf(ScopedStatement);

    const rows = stmt.all<{ id: string }>();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('a1');
  });

  it('ScopedStatement.get returns undefined for wrong tenant', () => {
    createTestTable();
    insertItem('tenant-b', 'b1', 'Beta');

    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const stmt = scoped.prepare(
      'SELECT * FROM test_items WHERE tenant_id = $tenant_id AND id = $id',
    );
    const row = stmt.get({ id: 'b1' });
    expect(row).toBeUndefined();
  });

  it('ScopedStatement.run executes correctly', () => {
    createTestTable();
    const scoped = new ScopedDb(getDb(), 'tenant-a');
    const stmt = scoped.prepare(
      'INSERT INTO test_items (id, tenant_id, name) VALUES ($id, $tenant_id, $name)',
    );
    const result = stmt.run({ id: 'a1', name: 'Alpha' });
    expect(result.changes).toBe(1);
  });
});
