/**
 * Cross-tenant data isolation test suite (#239)
 *
 * Verifies that all tenant-scoped tables enforce isolation. Uses ScopedDb to
 * query data and asserts that tenant A never sees tenant B data and vice versa.
 *
 * Also documents that raw DB access (without ScopedDb) CAN see cross-tenant
 * data — proving that ScopedDb is required for enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from './db.js';
import { ScopedDb } from './scoped-db.js';

let tmpDir: string;
let scopedAlpha: ScopedDb;
let scopedBeta: ScopedDb;

const TENANT_ALPHA = 'tenant-alpha';
const TENANT_BETA = 'tenant-beta';

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
  const db = getDb();
  scopedAlpha = new ScopedDb(db, TENANT_ALPHA);
  scopedBeta = new ScopedDb(db, TENANT_BETA);
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Phase 2 Tables: users
// ---------------------------------------------------------------------------

describe('users table isolation', () => {
  function insertUser(tenantId: string, id: string, email: string): void {
    getDb().prepare(`
      INSERT INTO users (id, tenant_id, email, auth_provider, provider_id, role)
      VALUES (?, ?, ?, 'local', ?, 'viewer')
    `).run(id, tenantId, email, `local-${id}`);
  }

  it('ScopedDb.all() returns only own-tenant users', () => {
    insertUser(TENANT_ALPHA, 'u-a1', 'alpha@example.com');
    insertUser(TENANT_BETA, 'u-b1', 'beta@example.com');

    const alphaUsers = scopedAlpha.all<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = $tenant_id',
    );
    const betaUsers = scopedBeta.all<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = $tenant_id',
    );

    expect(alphaUsers.map((u) => u.id)).toEqual(['u-a1']);
    expect(betaUsers.map((u) => u.id)).toEqual(['u-b1']);
  });

  it('ScopedDb.get() returns undefined for cross-tenant lookup', () => {
    insertUser(TENANT_BETA, 'u-b1', 'beta@example.com');

    const row = scopedAlpha.get(
      'SELECT id FROM users WHERE tenant_id = $tenant_id AND id = $id',
      { id: 'u-b1' },
    );
    expect(row).toBeUndefined();
  });

  it('raw DB access CAN see cross-tenant data (documents enforcement gap)', () => {
    insertUser(TENANT_ALPHA, 'u-a1', 'alpha@example.com');
    insertUser(TENANT_BETA, 'u-b1', 'beta@example.com');

    const allUsers = getDb().prepare('SELECT id FROM users').all() as { id: string }[];
    expect(allUsers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 Tables: oauth_states
// ---------------------------------------------------------------------------

describe('oauth_states table isolation', () => {
  function insertOAuthState(tenantId: string, state: string): void {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    getDb().prepare(`
      INSERT INTO oauth_states (state, tenant_id, provider, created_at, expires_at)
      VALUES (?, ?, 'google', ?, ?)
    `).run(state, tenantId, now(), expiresAt);
  }

  it('each tenant sees only its own oauth states', () => {
    insertOAuthState(TENANT_ALPHA, 'state-alpha-1');
    insertOAuthState(TENANT_BETA, 'state-beta-1');

    const alphaStates = scopedAlpha.all<{ state: string }>(
      'SELECT state FROM oauth_states WHERE tenant_id = $tenant_id',
    );
    const betaStates = scopedBeta.all<{ state: string }>(
      'SELECT state FROM oauth_states WHERE tenant_id = $tenant_id',
    );

    expect(alphaStates.map((s) => s.state)).toEqual(['state-alpha-1']);
    expect(betaStates.map((s) => s.state)).toEqual(['state-beta-1']);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 Tables: refresh_tokens
// ---------------------------------------------------------------------------

describe('refresh_tokens table isolation', () => {
  function insertRefreshToken(tenantId: string, id: string, userId: string): void {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    getDb().prepare(`
      INSERT INTO refresh_tokens (id, tenant_id, token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, `hash-${id}`, userId, expiresAt, now());
  }

  it('each tenant sees only its own refresh tokens', () => {
    insertRefreshToken(TENANT_ALPHA, 'rt-a1', 'user-a');
    insertRefreshToken(TENANT_BETA, 'rt-b1', 'user-b');

    const alphaTokens = scopedAlpha.all<{ id: string }>(
      'SELECT id FROM refresh_tokens WHERE tenant_id = $tenant_id',
    );
    const betaTokens = scopedBeta.all<{ id: string }>(
      'SELECT id FROM refresh_tokens WHERE tenant_id = $tenant_id',
    );

    expect(alphaTokens.map((t) => t.id)).toEqual(['rt-a1']);
    expect(betaTokens.map((t) => t.id)).toEqual(['rt-b1']);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 Tables: user_preferences
// ---------------------------------------------------------------------------

describe('user_preferences table isolation', () => {
  function insertPref(tenantId: string, userId: string, key: string, value: string): void {
    getDb().prepare(`
      INSERT INTO user_preferences (id, tenant_id, user_id, key, value)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), tenantId, userId, key, value);
  }

  it('each tenant sees only its own user preferences', () => {
    insertPref(TENANT_ALPHA, 'user-a', 'theme', 'dark');
    insertPref(TENANT_BETA, 'user-b', 'theme', 'light');

    const alphaPrefs = scopedAlpha.all<{ value: string }>(
      "SELECT value FROM user_preferences WHERE tenant_id = $tenant_id AND key = 'theme'",
    );
    const betaPrefs = scopedBeta.all<{ value: string }>(
      "SELECT value FROM user_preferences WHERE tenant_id = $tenant_id AND key = 'theme'",
    );

    expect(alphaPrefs.map((p) => p.value)).toEqual(['dark']);
    expect(betaPrefs.map((p) => p.value)).toEqual(['light']);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Tables: tenant_configs
// ---------------------------------------------------------------------------

describe('tenant_configs table isolation', () => {
  function insertConfig(tenantId: string, key: string, value: string): void {
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), tenantId, key, value);
  }

  it('each tenant sees only its own config overrides', () => {
    insertConfig(TENANT_ALPHA, 'model', 'gpt-4o');
    insertConfig(TENANT_BETA, 'model', 'claude-3');

    const alphaConfigs = scopedAlpha.all<{ value: string }>(
      "SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id AND key = 'model'",
    );
    const betaConfigs = scopedBeta.all<{ value: string }>(
      "SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id AND key = 'model'",
    );

    expect(alphaConfigs.map((c) => c.value)).toEqual(['gpt-4o']);
    expect(betaConfigs.map((c) => c.value)).toEqual(['claude-3']);
  });

  it('ScopedDb.get() returns undefined for cross-tenant config lookup', () => {
    insertConfig(TENANT_BETA, 'secret_key', 'beta-secret');

    const row = scopedAlpha.get(
      "SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id AND key = 'secret_key'",
    );
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Tables: tenant_api_keys
// ---------------------------------------------------------------------------

describe('tenant_api_keys table isolation', () => {
  function insertApiKey(tenantId: string, provider: string): void {
    getDb().prepare(`
      INSERT INTO tenant_api_keys
        (id, tenant_id, provider, encrypted_key, iv, auth_tag, key_hint)
      VALUES (?, ?, ?, 'encrypted', 'iv', 'tag', 'sk-...')
    `).run(randomUUID(), tenantId, provider);
  }

  it('each tenant sees only its own API keys', () => {
    insertApiKey(TENANT_ALPHA, 'openai');
    insertApiKey(TENANT_BETA, 'openai');

    const alphaKeys = scopedAlpha.all<{ provider: string }>(
      'SELECT provider FROM tenant_api_keys WHERE tenant_id = $tenant_id',
    );
    const betaKeys = scopedBeta.all<{ provider: string }>(
      'SELECT provider FROM tenant_api_keys WHERE tenant_id = $tenant_id',
    );

    expect(alphaKeys).toHaveLength(1);
    expect(betaKeys).toHaveLength(1);
  });

  it('ScopedDb.get() cannot access another tenant api key', () => {
    insertApiKey(TENANT_BETA, 'anthropic');
    const row = scopedAlpha.get(
      "SELECT provider FROM tenant_api_keys WHERE tenant_id = $tenant_id AND provider = 'anthropic'",
    );
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Tables: tenant_quota_limits
// ---------------------------------------------------------------------------

describe('tenant_quota_limits table isolation', () => {
  function insertLimit(tenantId: string, resource: string, limit: number): void {
    getDb().prepare(`
      INSERT INTO tenant_quota_limits (tenant_id, resource, limit_value)
      VALUES (?, ?, ?)
    `).run(tenantId, resource, limit);
  }

  it('each tenant sees only its own quota limits', () => {
    insertLimit(TENANT_ALPHA, 'tokens', 10000);
    insertLimit(TENANT_BETA, 'tokens', 5000);

    const alphaLimits = scopedAlpha.all<{ limit_value: number }>(
      'SELECT limit_value FROM tenant_quota_limits WHERE tenant_id = $tenant_id',
    );
    const betaLimits = scopedBeta.all<{ limit_value: number }>(
      'SELECT limit_value FROM tenant_quota_limits WHERE tenant_id = $tenant_id',
    );

    expect(alphaLimits.map((l) => l.limit_value)).toEqual([10000]);
    expect(betaLimits.map((l) => l.limit_value)).toEqual([5000]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Tables: quota_usage
// ---------------------------------------------------------------------------

describe('quota_usage table isolation', () => {
  function insertUsage(tenantId: string, resource: string, used: number): void {
    const period = '2026-03';
    getDb().prepare(`
      INSERT INTO quota_usage (id, tenant_id, resource, period, used)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), tenantId, resource, period, used);
  }

  it('each tenant sees only its own quota usage', () => {
    insertUsage(TENANT_ALPHA, 'tokens', 500);
    insertUsage(TENANT_BETA, 'tokens', 800);

    const alphaUsage = scopedAlpha.all<{ used: number }>(
      'SELECT used FROM quota_usage WHERE tenant_id = $tenant_id',
    );
    const betaUsage = scopedBeta.all<{ used: number }>(
      'SELECT used FROM quota_usage WHERE tenant_id = $tenant_id',
    );

    expect(alphaUsage.map((u) => u.used)).toEqual([500]);
    expect(betaUsage.map((u) => u.used)).toEqual([800]);
  });
});

// ---------------------------------------------------------------------------
// SQL injection edge cases
// ---------------------------------------------------------------------------

describe('SQL injection edge cases', () => {
  it("injection attempt via tenantId (' OR '1'='1) does not leak cross-tenant data", () => {
    // Insert data for a legitimate tenant
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_ALPHA, 'secret', 'alpha-secret');

    // Attempt injection via tenantId
    const maliciousTenantId = "' OR '1'='1";
    const injectedScoped = new ScopedDb(getDb(), maliciousTenantId);
    const rows = injectedScoped.all(
      'SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id',
    );
    // Named params prevent injection — the literal string is used as tenant_id
    // so it matches nothing (no row has tenant_id = "' OR '1'='1")
    expect(rows).toHaveLength(0);
  });

  it("injection attempt via tenantId (tenant-alpha' --) does not leak data", () => {
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_ALPHA, 'secret', 'alpha-secret');

    const maliciousTenantId = "tenant-alpha' --";
    const injectedScoped = new ScopedDb(getDb(), maliciousTenantId);
    const rows = injectedScoped.all(
      'SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id',
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withTenant() isolation boundary
// ---------------------------------------------------------------------------

describe('withTenant() isolation boundary', () => {
  it('creates a properly isolated scope for the new tenant', () => {
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_ALPHA, 'key1', 'alpha-val');
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_BETA, 'key1', 'beta-val');

    const scopedB = scopedAlpha.withTenant(TENANT_BETA);
    const rows = scopedB.all<{ value: string }>(
      'SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id',
    );
    expect(rows.map((r) => r.value)).toEqual(['beta-val']);
  });

  it('original scope is unchanged after withTenant()', () => {
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_ALPHA, 'key1', 'alpha-val');

    scopedAlpha.withTenant(TENANT_BETA);
    const rows = scopedAlpha.all<{ value: string }>(
      'SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id',
    );
    expect(rows.map((r) => r.value)).toEqual(['alpha-val']);
  });
});

// ---------------------------------------------------------------------------
// raw access documents enforcement gap
// ---------------------------------------------------------------------------

describe('raw DB access bypasses ScopedDb isolation', () => {
  it('raw access CAN see all tenants data (ScopedDb is required for enforcement)', () => {
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_ALPHA, 'key', 'val-a');
    getDb().prepare(`
      INSERT INTO tenant_configs (id, tenant_id, key, value)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), TENANT_BETA, 'key', 'val-b');

    // Raw access sees everything — not filtered by tenant
    const allRows = scopedAlpha.raw
      .prepare('SELECT value FROM tenant_configs')
      .all() as { value: string }[];
    expect(allRows).toHaveLength(2);

    // ScopedDb access only sees own tenant
    const alphaRows = scopedAlpha.all<{ value: string }>(
      'SELECT value FROM tenant_configs WHERE tenant_id = $tenant_id',
    );
    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0].value).toBe('val-a');
  });
});
