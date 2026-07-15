/**
 * Fastify plugin — decorates request.db with a ScopedDb instance (#235)
 *
 * Reads the authenticated user's tenant_id from request.user (set by the
 * auth guard in api-routes.ts) and creates a ScopedDb scoped to that tenant.
 * Falls back to 'default' for unauthenticated/public routes.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from './db.js';
import { ScopedDb } from './scoped-db.js';

declare module 'fastify' {
  interface FastifyRequest {
    db: ScopedDb;
  }
}

/**
 * Fastify plugin that decorates every request with `request.db` as a
 * ScopedDb instance scoped to the authenticated user's tenant_id.
 *
 * The tenant_id is extracted from `request.user?.tenant_id` (set by the
 * auth guard). Falls back to 'default' for unauthenticated/public routes.
 *
 * Register after the auth guard so that user context is already set when
 * the preHandler hook runs.
 */
export async function scopedDbPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('db', {
    getter() {
      return new ScopedDb(getDb(), 'default');
    },
  });

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const user = (request as FastifyRequest & { user?: { tenant_id?: string } }).user;
    const tenantId = user?.tenant_id ?? 'default';
    request.db = new ScopedDb(getDb(), tenantId);
  });
}
