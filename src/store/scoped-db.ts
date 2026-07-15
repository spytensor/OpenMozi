/**
 * ScopedDb — tenant-scoped database wrapper (#235)
 *
 * Wraps better-sqlite3 and auto-injects tenant_id into all queries using
 * SQLite named parameters ($tenant_id). Prevents cross-tenant data leakage
 * at the query layer.
 *
 * Usage:
 *   const scoped = new ScopedDb(getDb(), 'tenant-a');
 *   const users = scoped.all('SELECT * FROM users WHERE tenant_id = $tenant_id');
 *   const user = scoped.get('SELECT * FROM users WHERE tenant_id = $tenant_id AND id = $id', { id });
 *   scoped.run('DELETE FROM users WHERE tenant_id = $tenant_id AND id = $id', { id });
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Legacy SQL rewriting helpers (kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Rewrites a SELECT/UPDATE/DELETE SQL string to add a `tenant_id = ?`
 * constraint, appending the corresponding bind value to the params array.
 *
 * @deprecated Use ScopedDb with named parameters ($tenant_id) instead.
 */
export function injectTenantScope(
  sql: string,
  params: readonly unknown[],
  tenantId: string,
): { sql: string; params: unknown[] } {
  const trimmed = sql.trimStart();
  const upper = trimmed.toUpperCase();

  // INSERT statements: caller must include tenant_id in column list
  if (upper.startsWith('INSERT')) {
    const colSection = trimmed.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i);
    if (!colSection) {
      throw new Error('ScopedDb: INSERT must use explicit column list — cannot auto-scope');
    }
    const cols = colSection[1].split(',').map((c) => c.trim().toLowerCase());
    if (!cols.includes('tenant_id')) {
      throw new Error('ScopedDb: INSERT must include tenant_id in column list');
    }
    return { sql, params: [...params] };
  }

  // Tokens that terminate the WHERE-eligible part of the query
  const TERMINATORS = /\b(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|FOR\s+UPDATE)\b/i;

  // Find the position of an existing WHERE clause
  const whereMatch = trimmed.match(/\bWHERE\b/i);

  let rewritten: string;
  if (whereMatch && whereMatch.index !== undefined) {
    // Append after the WHERE clause but before any terminator
    const afterWhere = trimmed.slice(whereMatch.index + 'WHERE'.length);
    const terminatorMatch = afterWhere.match(TERMINATORS);
    if (terminatorMatch && terminatorMatch.index !== undefined) {
      // Insert before terminator
      const insertAt = whereMatch.index + 'WHERE'.length + terminatorMatch.index;
      rewritten =
        trimmed.slice(0, insertAt) +
        ' AND tenant_id = ? ' +
        trimmed.slice(insertAt);
    } else {
      // No terminator — just append
      rewritten = trimmed + ' AND tenant_id = ?';
    }
  } else {
    // No WHERE clause — find where to insert one
    const terminatorMatch = trimmed.match(TERMINATORS);
    if (terminatorMatch && terminatorMatch.index !== undefined) {
      rewritten =
        trimmed.slice(0, terminatorMatch.index) +
        ' WHERE tenant_id = ? ' +
        trimmed.slice(terminatorMatch.index);
    } else {
      rewritten = trimmed + ' WHERE tenant_id = ?';
    }
  }

  return { sql: rewritten, params: [...params, tenantId] };
}

// ---------------------------------------------------------------------------
// ScopedStatement
// ---------------------------------------------------------------------------

/**
 * A prepared-statement wrapper that automatically pre-binds tenant_id to
 * prevent cross-tenant data access.
 */
export class ScopedStatement {
  constructor(
    private readonly stmt: Database.Statement,
    private readonly tenantId: string,
  ) {}

  /**
   * Execute the statement and return all matching rows.
   */
  all<T>(params?: Record<string, unknown>): T[] {
    return this.stmt.all({ tenant_id: this.tenantId, ...params }) as T[];
  }

  /**
   * Execute the statement and return the first matching row, or undefined.
   */
  get<T>(params?: Record<string, unknown>): T | undefined {
    return this.stmt.get({ tenant_id: this.tenantId, ...params }) as T | undefined;
  }

  /**
   * Execute the statement (INSERT/UPDATE/DELETE) and return the run result.
   */
  run(params?: Record<string, unknown>): Database.RunResult {
    return this.stmt.run({ tenant_id: this.tenantId, ...params });
  }
}

// ---------------------------------------------------------------------------
// ScopedDb class
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped database wrapper.
 *
 * Wraps a better-sqlite3 Database instance and automatically injects
 * `tenant_id` into all query parameters via SQLite named parameters.
 * All queries that include `$tenant_id` in their SQL will have it set
 * to the current tenant.
 */
export class ScopedDb {
  constructor(
    private readonly db: Database.Database,
    readonly tenantId: string,
  ) {}

  /**
   * Execute a SELECT query and return all matching rows.
   * Automatically injects `tenant_id` into named params.
   */
  all<T>(sql: string, params?: Record<string, unknown>): T[] {
    return this.db.prepare(sql).all({ tenant_id: this.tenantId, ...params }) as T[];
  }

  /**
   * Execute a SELECT query and return the first matching row, or undefined.
   * Automatically injects `tenant_id` into named params.
   */
  get<T>(sql: string, params?: Record<string, unknown>): T | undefined {
    return this.db.prepare(sql).get({ tenant_id: this.tenantId, ...params }) as T | undefined;
  }

  /**
   * Execute a write query (INSERT/UPDATE/DELETE) and return the run result.
   * Automatically injects `tenant_id` into named params.
   */
  run(sql: string, params?: Record<string, unknown>): Database.RunResult {
    return this.db.prepare(sql).run({ tenant_id: this.tenantId, ...params });
  }

  /**
   * Prepare a reusable statement with tenant_id pre-bound.
   */
  prepare(sql: string): ScopedStatement {
    return new ScopedStatement(this.db.prepare(sql), this.tenantId);
  }

  /**
   * Expose the underlying database for admin/migration operations.
   * Use sparingly — bypasses tenant isolation.
   */
  get raw(): Database.Database {
    return this.db;
  }

  /**
   * Create a new ScopedDb instance scoped to a different tenant.
   * Useful for admin operations that need to cross tenant boundaries.
   */
  withTenant(tenantId: string): ScopedDb {
    return new ScopedDb(this.db, tenantId);
  }

  // ---------------------------------------------------------------------------
  // Legacy positional-param API (kept for backward compatibility)
  // ---------------------------------------------------------------------------

  /**
   * @deprecated Use all() with named parameters instead.
   */
  scopedAll<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): T[] {
    const { sql: scoped, params: scopedParams } = injectTenantScope(sql, params, this.tenantId);
    return this.db.prepare(scoped).all(...scopedParams) as T[];
  }

  /**
   * @deprecated Use get() with named parameters instead.
   */
  scopedGet<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): T | undefined {
    const { sql: scoped, params: scopedParams } = injectTenantScope(sql, params, this.tenantId);
    return this.db.prepare(scoped).get(...scopedParams) as T | undefined;
  }

  /**
   * @deprecated Use run() with named parameters instead.
   */
  scopedRun(
    sql: string,
    params: readonly unknown[] = [],
  ): Database.RunResult {
    const { sql: scoped, params: scopedParams } = injectTenantScope(sql, params, this.tenantId);
    return this.db.prepare(scoped).run(...scopedParams);
  }
}

// ---------------------------------------------------------------------------
// Fastify plugin — injects req.scopedDb from authenticated tenant_id
// ---------------------------------------------------------------------------

import { getDb } from './db.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    scopedDb: ScopedDb;
  }
}

/**
 * Fastify plugin that decorates every request with `req.scopedDb`.
 *
 * The tenant_id is extracted from `req.tenantContext` (set by the auth guard
 * in api-routes.ts after JWT/OIDC/SAML verification). Falls back to 'default'
 * for unauthenticated/public routes so that the decorator is always present.
 *
 * Register after cookie/auth plugins so tenantContext is available on onRequest.
 */
export async function scopedDbPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('scopedDb', {
    getter() {
      return new ScopedDb(getDb(), 'default');
    },
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    request.scopedDb = new ScopedDb(getDb(), tenantId);
  });
}
