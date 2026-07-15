import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';
import { getAccessibleChatIdsForUser } from '../memory/conversations.js';
import { resolveMemoryEmbeddingProvider } from '../memory/embedding-provider.js';
import {
  deleteAllAccessibleFacts,
  deleteFactById,
  getAccessibleFacts,
  recallFacts,
  updateFactValue,
  type FactCategory,
  type MemoryAccessScope,
} from '../memory/long-term.js';
import { applyMemoryMutation } from '../memory/mutations.js';
import { getRecentDigests } from '../memory/session-digest.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

function context(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function memoryScope(tenant: TenantContext | undefined): MemoryAccessScope | undefined {
  if (!tenant?.user_id) return undefined;
  return {
    userId: tenant.user_id,
    accessibleChatIds: getAccessibleChatIdsForUser(tenant.user_id, tenant.tenant_id),
  };
}

function browseScope(tenant: TenantContext | undefined): MemoryAccessScope | undefined {
  const scope = memoryScope(tenant);
  if (!scope) return undefined;
  return {
    ...scope,
    accessibleChatIds: [...new Set([...scope.accessibleChatIds, '__profile__', '__semantic__'])],
  };
}

export function registerMemoryRoutes(app: FastifyInstance): void {
  app.get('/api/memory/facts', async (request, reply) => {
    const query = request.query as { category?: string };
    const tenant = context(request);
    const facts = getAccessibleFacts(
      tenant?.tenant_id ?? 'default',
      browseScope(tenant),
      query.category as FactCategory | undefined,
    );
    return reply.send({ facts });
  });

  app.get('/api/memory/search', async (request, reply) => {
    const query = request.query as { q?: string; chatId?: string; limit?: string };
    if (!query.q) return reply.code(400).send({ error: 'Missing query parameter: q' });
    const tenant = context(request);
    const facts = await recallFacts(
      query.chatId || 'global',
      query.q,
      tenant?.tenant_id ?? 'default',
      query.limit ? parseInt(query.limit, 10) : 10,
      memoryScope(tenant),
    );
    return reply.send({ facts });
  });

  app.delete('/api/memory/facts/:id', async (request, reply) => {
    const numericId = parseInt((request.params as { id: string }).id, 10);
    if (Number.isNaN(numericId)) return reply.code(400).send({ error: 'Invalid fact ID' });
    const tenant = context(request);
    const deleted = deleteFactById(numericId, tenant?.tenant_id ?? 'default', memoryScope(tenant));
    if (!deleted) return reply.code(404).send({ error: 'Fact not found' });
    return reply.send({ ok: true });
  });

  app.patch('/api/memory/facts/:id', async (request, reply) => {
    const numericId = parseInt((request.params as { id: string }).id, 10);
    if (Number.isNaN(numericId)) return reply.code(400).send({ error: 'Invalid fact ID' });
    const value = typeof (request.body as { value?: string })?.value === 'string'
      ? (request.body as { value: string }).value.trim()
      : '';
    if (!value) return reply.code(400).send({ error: 'Missing value' });
    const tenant = context(request);
    const fact = updateFactValue(numericId, value, tenant?.tenant_id ?? 'default', memoryScope(tenant));
    if (!fact) return reply.code(404).send({ error: 'Fact not found' });
    return reply.send({ fact });
  });

  app.post('/api/memory/facts', async (request, reply) => {
    const body = request.body as { category?: string; value?: string; key?: string };
    const validCategories = ['preference', 'fact', 'decision', 'lesson'] as const;
    const category = validCategories.includes(body?.category as never) ? body.category as FactCategory : null;
    const value = typeof body?.value === 'string' ? body.value.trim() : '';
    if (!category) return reply.code(400).send({ error: 'Invalid category' });
    if (!value) return reply.code(400).send({ error: 'Missing value' });
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const userId = tenant?.user_id;
    const chatId = userId ?? 'global';
    const key = typeof body?.key === 'string' && body.key.trim()
      ? body.key.trim()
      : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mutation = applyMemoryMutation({
      chatId,
      category,
      key,
      value,
      source: 'manual',
      tenantId,
      userId,
      salienceHint: 0.7,
      requestedAction: 'AUTO',
    });
    return reply.code(mutation.action === 'ADD' ? 201 : 200).send(mutation);
  });

  app.get('/api/memory/status', async (request, reply) => {
    const config = getConfig();
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const resolution = resolveMemoryEmbeddingProvider(config, process.env, tenantId);
    const factCount = getAccessibleFacts(tenantId, browseScope(tenant)).length;
    const semanticActive = resolution.provider !== null
      && factCount >= config.memory.semantic_activation_threshold;
    return reply.send({
      recall_strategy: config.memory.recall_strategy,
      search_mode: semanticActive ? 'semantic_hybrid' : 'local_fts',
      semantic_enabled: semanticActive,
      semantic_available: resolution.provider !== null,
      embedding_provider: resolution.provider?.providerName ?? null,
      embedding_model: resolution.provider?.modelName ?? null,
      activation_threshold: config.memory.semantic_activation_threshold,
      fact_count: factCount,
      reason: semanticActive
        ? resolution.reason
        : resolution.provider
          ? 'below_semantic_activation_threshold'
          : resolution.reason,
    });
  });

  app.get('/api/memory/export', async (request, reply) => {
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const facts = getAccessibleFacts(tenantId, browseScope(tenant));
    reply.header('Content-Disposition', 'attachment; filename="mozi-memory.json"');
    return reply.send({ exported_at: new Date().toISOString(), tenant_id: tenantId, count: facts.length, facts });
  });

  app.delete('/api/memory/facts', async (request, reply) => {
    const tenant = context(request);
    const deleted = deleteAllAccessibleFacts(tenant?.tenant_id ?? 'default', memoryScope(tenant));
    return reply.send({ ok: true, deleted });
  });

  app.get('/api/memory/digests', async (request, reply) => {
    const tenant = context(request);
    if (!tenant?.user_id) return reply.send({ digests: [] });
    return reply.send({ digests: getRecentDigests(tenant.user_id, tenant.tenant_id, 30, 20) });
  });
}
