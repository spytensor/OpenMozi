import type { FastifyInstance } from 'fastify';
import { getAccessibleChatIdsForUser } from '../memory/conversations.js';
import { addCronTask, cancelCronTask, listCronTasks } from '../scheduler/cron-tasks.js';
import { addReminder, listReminders } from '../scheduler/reminders.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

function context(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function canAccessChat(tenant: TenantContext | undefined, chatId: string): boolean {
  if (!tenant?.user_id) return true;
  return getAccessibleChatIdsForUser(tenant.user_id, tenant.tenant_id).includes(chatId);
}

export function registerSchedulerRoutes(app: FastifyInstance): void {
  app.get('/api/scheduler/tasks', async (request, reply) => {
    const tenant = context(request);
    const tasks = listCronTasks(tenant?.tenant_id ?? 'default').filter(task => canAccessChat(tenant, task.chat_id));
    return reply.send({ tasks });
  });

  app.post('/api/scheduler/tasks', async (request, reply) => {
    const body = request.body as {
      chatId: string;
      scheduleKind: 'at' | 'every' | 'cron';
      scheduleValue: string;
      handlerType: string;
      handlerParams?: Record<string, unknown>;
      description: string;
      deleteAfterRun?: boolean;
      timezone?: string;
    };
    if (!body.chatId || !body.scheduleKind || !body.scheduleValue || !body.handlerType || !body.description) {
      return reply.code(400).send({ error: 'Missing required fields: chatId, scheduleKind, scheduleValue, handlerType, description' });
    }
    const tenant = context(request);
    if (!canAccessChat(tenant, body.chatId)) return reply.code(404).send({ error: 'Chat not found' });
    return reply.send({ task: addCronTask({ ...body, tenantId: tenant?.tenant_id ?? 'default' }) });
  });

  app.delete('/api/scheduler/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const task = listCronTasks(tenantId).find(entry => entry.id === id && canAccessChat(tenant, entry.chat_id));
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    cancelCronTask(id, tenantId);
    return reply.send({ ok: true });
  });

  app.get('/api/scheduler/reminders', async (request, reply) => {
    const tenant = context(request);
    const reminders = listReminders(tenant?.tenant_id ?? 'default').filter(reminder => canAccessChat(tenant, reminder.chat_id));
    return reply.send({ reminders });
  });

  app.post('/api/scheduler/reminders', async (request, reply) => {
    const body = request.body as { chatId?: string; message: string; delayMinutes: number };
    if (!body.message || !body.delayMinutes) return reply.code(400).send({ error: 'Missing required fields: message, delayMinutes' });
    const tenant = context(request);
    const requested = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const chatId = requested && canAccessChat(tenant, requested) ? requested : (tenant?.user_id ?? requested);
    if (!chatId) return reply.code(400).send({ error: 'Unable to resolve a chat for this reminder' });
    return reply.send({ reminder: addReminder(chatId, body.message, body.delayMinutes, tenant?.tenant_id ?? 'default') });
  });
}
