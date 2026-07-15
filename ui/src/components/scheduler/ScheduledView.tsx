import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Bell, CalendarClock, Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";

interface SchedulerTask {
  id?: string;
  name?: string;
  title?: string;
  next_run_at?: string | null;
  next_run?: string | null;
  nextRunAt?: string | null;
  last_status?: string | null;
  lastStatus?: string | null;
  status?: string | null;
  last_error?: string | null;
  lastError?: string | null;
  error?: string | null;
}

interface Reminder {
  id: number;
  chat_id: string;
  message: string;
  fire_at: string;
  fired: number;
}

type StatusTone = "ok" | "failed" | "unknown";

function normalizeTasks(payload: unknown): SchedulerTask[] {
  if (Array.isArray(payload)) return payload as SchedulerTask[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tasks)) return record.tasks as SchedulerTask[];
  return [];
}

function normalizeReminders(payload: unknown): Reminder[] {
  if (Array.isArray(payload)) return payload as Reminder[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.reminders)) return record.reminders as Reminder[];
  return [];
}

function taskName(task: SchedulerTask): string | null {
  return task.name || task.title || null;
}

function nextRunValue(task: SchedulerTask): string | null {
  return task.next_run_at || task.next_run || task.nextRunAt || null;
}

function lastStatusValue(task: SchedulerTask): string | null {
  return task.last_status || task.lastStatus || task.status || null;
}

function lastErrorValue(task: SchedulerTask): string | null {
  return task.last_error || task.lastError || task.error || null;
}

function statusTone(status: string | null): StatusTone {
  const normalized = (status ?? "").toLowerCase();
  if (["ok", "success", "succeeded", "completed", "done"].includes(normalized)) return "ok";
  if (["failed", "failure", "error", "errored"].includes(normalized)) return "failed";
  return "unknown";
}

function formatNextRun(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function ScheduledView() {
  const { locale, t } = useLocale();
  const { get, post, del } = useApi();
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [reminderMessage, setReminderMessage] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("15");
  const [submittingReminder, setSubmittingReminder] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remindersError, setRemindersError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await get<unknown>("/api/scheduler/tasks");
    if (result.error) {
      setTasks([]);
      setError(result.error);
    } else {
      setTasks(normalizeTasks(result.data));
    }
    setLoading(false);
  }, [get]);

  const loadReminders = useCallback(async () => {
    setRemindersLoading(true);
    setRemindersError(null);
    const result = await get<unknown>("/api/scheduler/reminders");
    if (result.error) {
      setReminders([]);
      setRemindersError(result.error);
    } else {
      setReminders(normalizeReminders(result.data));
    }
    setRemindersLoading(false);
  }, [get]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadReminders();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadReminders]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aTime = Date.parse(nextRunValue(a) ?? "");
      const bTime = Date.parse(nextRunValue(b) ?? "");
      return (Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    });
  }, [tasks]);

  const sortedReminders = useMemo(() => {
    return [...reminders].sort((a, b) => {
      const aTime = Date.parse(a.fire_at);
      const bTime = Date.parse(b.fire_at);
      return (Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    });
  }, [reminders]);

  const addReminder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = reminderMessage.trim();
    const minutes = Number(delayMinutes);
    if (!message || !Number.isFinite(minutes) || minutes <= 0) return;
    setSubmittingReminder(true);
    setRemindersError(null);
    const result = await post("/api/scheduler/reminders", {
      chatId: "local-user",
      message,
      delayMinutes: minutes,
    });
    setSubmittingReminder(false);
    if (result.error) {
      setRemindersError(result.error);
      return;
    }
    setReminderMessage("");
    void loadReminders();
  };

  const deleteTask = async (task: SchedulerTask) => {
    if (!task.id) return;
    if (!window.confirm(t("scheduler.task_delete_confirm", { name: taskName(task) ?? task.id }))) return;
    setDeletingTaskId(task.id);
    setError(null);
    const result = await del(`/api/scheduler/tasks/${encodeURIComponent(task.id)}`);
    setDeletingTaskId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    void loadTasks();
  };

  return (
    <WorkspacePage testId="scheduled-scroll-region" contentClassName="max-w-[960px]">
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-normal text-ink/85">{t("scheduled.title")}</h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/40">{t("scheduled.description")}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadTasks()}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </button>
        </header>

        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center text-ink/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-[13px]">{t("scheduled.loading")}</span>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-[12.5px] text-warning">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("scheduled.error", { error })}</span>
              <button type="button" onClick={() => void loadTasks()} className="shrink-0 underline underline-offset-4">
                {t("common.retry")}
              </button>
            </div>
          </div>
        ) : sortedTasks.length === 0 ? (
          <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.015] px-4 py-10 text-center text-[13px] text-ink/36">
            {t("scheduled.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-ink/[0.06] bg-ink/[0.015]">
            {sortedTasks.map((task, index) => (
              <ScheduledTaskRow
                key={task.id ?? `${taskName(task) ?? "task"}-${index}`}
                task={task}
                locale={locale}
                deleting={!!task.id && deletingTaskId === task.id}
                onDelete={deleteTask}
              />
            ))}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-ink/82">{t("scheduler.reminders_section")}</h2>
          </div>

          <form
            onSubmit={(event) => void addReminder(event)}
            className="grid gap-2 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_140px_auto] md:items-end"
            style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}
          >
            <label className="min-w-0">
              <span className="sr-only">{t("scheduler.new_reminder")}</span>
              <input
                value={reminderMessage}
                onChange={(event) => setReminderMessage(event.target.value)}
                placeholder={t("scheduler.reminder_message_placeholder")}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              />
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] text-ink/45">{t("scheduler.reminder_delay_label")}</span>
              <input
                type="number"
                min="1"
                value={delayMinutes}
                onChange={(event) => setDelayMinutes(event.target.value)}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              />
            </label>
            <button
              type="submit"
              disabled={submittingReminder || !reminderMessage.trim() || Number(delayMinutes) <= 0}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              {submittingReminder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t("scheduler.reminder_add_button")}
            </button>
          </form>

          {remindersError && (
            <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-[12.5px] text-warning">
              {t("scheduler.reminders_error", { error: remindersError })}
            </div>
          )}

          {remindersLoading ? (
            <div className="flex min-h-[96px] items-center justify-center text-ink/45">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span className="text-[13px]">{t("scheduler.reminders_loading")}</span>
            </div>
          ) : sortedReminders.length === 0 ? (
            <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.015] px-4 py-8 text-center text-[13px] text-ink/36">
              {t("scheduler.no_reminders")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink/[0.06] bg-ink/[0.015]">
              {sortedReminders.map((reminder) => (
                <ReminderRow key={reminder.id} reminder={reminder} locale={locale} />
              ))}
            </div>
          )}
        </section>
      </div>
    </WorkspacePage>
  );
}

function ScheduledTaskRow({
  task,
  locale,
  deleting,
  onDelete,
}: {
  task: SchedulerTask;
  locale: string;
  deleting: boolean;
  onDelete: (task: SchedulerTask) => void;
}) {
  const { t } = useLocale();
  const status = lastStatusValue(task);
  const tone = statusTone(status);
  const lastError = lastErrorValue(task);
  const nextRun = formatNextRun(nextRunValue(task), locale, t("scheduled.noNextRun"));
  const statusLabel = tone === "ok"
    ? t("scheduled.status.ok")
    : tone === "failed"
      ? t("scheduled.status.failed")
      : t("scheduled.status.unknown");
  const dotColor = tone === "ok" ? "var(--success)" : tone === "failed" ? "var(--danger)" : "rgb(var(--ink-rgb) / 0.24)";

  return (
    <article className="grid gap-2 border-b border-ink/[0.045] px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_minmax(120px,180px)_auto] md:items-start">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" />
        <div className="min-w-0">
          <h2 className="truncate text-[13.5px] font-medium text-ink/82">{taskName(task) ?? t("scheduled.unnamed")}</h2>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduled.nextRun")}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink/62">{nextRun}</div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduled.lastStatus")}</div>
        {tone === "failed" && lastError ? (
          <details className="mt-0.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-ink/64" title={lastError}>
              <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
              {statusLabel}
            </summary>
            <p className="mt-1 overflow-wrap-anywhere rounded-md bg-danger/10 px-2 py-1.5 text-[11px] leading-4 text-danger" title={lastError}>
              {lastError}
            </p>
          </details>
        ) : (
          <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink/64" title={lastError ?? statusLabel}>
            <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
            {statusLabel}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDelete(task)}
        disabled={!task.id || deleting}
        title={t("scheduler.task_delete")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
    </article>
  );
}

function ReminderRow({ reminder, locale }: { reminder: Reminder; locale: string }) {
  const { t } = useLocale();
  const fired = reminder.fired !== 0;
  const label = fired ? t("scheduler.reminder_fired") : t("scheduler.reminder_pending");
  const dotColor = fired ? "var(--success)" : "var(--accent)";

  return (
    <article className="grid gap-2 border-b border-ink/[0.045] px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_auto] md:items-start">
      <div className="flex min-w-0 items-start gap-2">
        <Bell className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" />
        <div className="min-w-0">
          <h3 className="overflow-wrap-anywhere text-[13.5px] font-medium text-ink/82">{reminder.message}</h3>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduler.reminder_fire_at")}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink/62">{formatNextRun(reminder.fire_at, locale, t("scheduled.noNextRun"))}</div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink/64">
        <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
        {label}
      </div>
    </article>
  );
}
