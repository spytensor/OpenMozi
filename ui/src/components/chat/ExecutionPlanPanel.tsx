import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Minus, RotateCcw, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";
import type { TimelineItem, TaskUpdate, ChatMessage } from "@/types";
import { cn } from "@/lib/utils";

/** Plan shape served by GET /api/sessions/:id/plans — mirrors the tasks table. */
export interface SessionPlanStep {
  id: string;
  title: string;
  status: string;
  guard_reason?: string;
  blocked_reason?: string;
}

export interface SessionPlan {
  id: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
  steps: SessionPlanStep[];
}

interface PlansResponse {
  sessionId: string;
  plans: SessionPlan[];
}

const TERMINAL_PLAN = new Set(["completed", "failed", "cancelled"]);
const DONE = new Set(["completed"]);
const FAILED = new Set(["failed"]);
const CANCELLED = new Set(["cancelled"]);
const RUNNING = new Set(["running", "assigned"]);
const BLOCKED = new Set(["blocked"]);

/** Tasks-table timestamps are SQLite UTC "YYYY-MM-DD HH:MM:SS" (datetime('now'));
 *  message timestamps are epoch ms. Normalize the former for comparison. */
function parseDbTime(value: string): number {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function StepStatusIcon({ status }: { status: string }) {
  if (DONE.has(status)) return <Check className="h-3.5 w-3.5 shrink-0 text-ink/55" strokeWidth={2} />;
  if (FAILED.has(status)) return <X className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--danger)" }} strokeWidth={2} />;
  if (CANCELLED.has(status)) return <Minus className="h-3.5 w-3.5 shrink-0 text-ink/35" strokeWidth={2} />;
  if (RUNNING.has(status)) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />;
  // pending / ready / blocked — a quiet outline
  return <span className="h-3.5 w-3.5 shrink-0 p-[3.5px]"><span className="block h-full w-full rounded-full border border-ink/30" /></span>;
}

/**
 * Session-anchored execution panel: the visible mirror of the plan spine.
 *
 * State comes from GET /api/sessions/:id/plans (the tasks table — the same
 * truth the runtime and the Brain grounding read), so a page refresh or a
 * process restart shows exactly the persisted progress. Live task_update /
 * assistant-message traffic on the timeline triggers a debounced refetch.
 *
 * Lifecycle rules:
 * - Every active plan gets its own row (concurrent plans are all visible and
 *   individually cancellable — a single-slot panel would flip between them).
 * - A terminal plan stays visible (collapsed) until the user sends a message
 *   AFTER it finished — the conversation moved on, so the row retires. Both
 *   timestamps are server-generated, so this survives a page refresh.
 */
export function ExecutionPlanPanel({
  sessionId,
  timeline,
}: {
  sessionId?: string | null;
  timeline: TimelineItem[];
}) {
  const { t } = useLocale();
  const { get, post } = useApi();
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingStepId, setRetryingStepId] = useState<string | null>(null);
  const autoExpandedRef = useRef<Set<string>>(new Set());
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const guardReasonLabel = useCallback((reason: string) => {
    const knownReasons: Record<string, Parameters<typeof t>[0]> = {
      loop_timeout: "plan.step.guard.loop_timeout",
      repeated_tool_failures: "plan.step.guard.repeated_tool_failures",
      loop_detected: "plan.step.guard.loop_detected",
      max_iterations: "plan.step.guard.max_iterations",
    };
    const key = knownReasons[reason];
    return key ? t(key) : reason;
  }, [t]);

  const refetch = useCallback(() => {
    if (!sessionId) return;
    get<PlansResponse>(`/api/sessions/${sessionId}/plans`).then(({ data }) => {
      if (data?.plans) setPlans(data.plans);
    });
  }, [get, sessionId]);

  const cancelPlan = useCallback(
    (planId: string) => {
      if (!sessionId || cancellingId) return;
      setCancellingId(planId);
      post(`/api/sessions/${sessionId}/plans/${planId}/cancel`)
        .then(() => refetch())
        .finally(() => setCancellingId(null));
    },
    [cancellingId, post, refetch, sessionId],
  );

  const retryStep = useCallback(
    (planId: string, stepId: string) => {
      if (!sessionId || retryingStepId) return;
      setRetryingStepId(stepId);
      post(`/api/sessions/${sessionId}/plans/${planId}/steps/${stepId}/retry`)
        .then(() => refetch())
        .finally(() => setRetryingStepId(null));
    },
    [post, refetch, retryingStepId, sessionId],
  );

  // Rehydrate on session switch.
  useEffect(() => {
    setPlans([]);
    setExpandedIds(new Set());
    setCancellingId(null);
    setRetryingStepId(null);
    autoExpandedRef.current = new Set();
    prevStatusRef.current = new Map();
    refetch();
  }, [refetch]);

  // Live signal: any task_update transition or new assistant message may mean
  // plan progress — refetch the truth from the DB (debounced).
  const liveSignal = useMemo(() => {
    let signal = "";
    let assistantCount = 0;
    for (const item of timeline) {
      if (item.type === "task_update") {
        const task = item.data as TaskUpdate;
        signal += `${task.task_id}:${task.status};`;
      } else if (item.type === "message" && (item.data as ChatMessage).role === "assistant") {
        assistantCount++;
      }
    }
    return `${signal}#${assistantCount}`;
  }, [timeline]);

  useEffect(() => {
    if (!sessionId) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refetch, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [liveSignal, refetch, sessionId]);

  // Poll while a plan is actively running so progress moves even without
  // websocket task events (e.g. reconnect gaps). Cheap: one indexed query.
  const hasActivePlan = plans.some((plan) => !TERMINAL_PLAN.has(plan.status));
  useEffect(() => {
    if (!hasActivePlan) return;
    const interval = setInterval(refetch, 5000);
    return () => clearInterval(interval);
  }, [hasActivePlan, refetch]);

  // Latest user-message timestamp — the "conversation moved on" watermark
  // that retires finished plans.
  const lastUserMessageTs = useMemo(() => {
    let latest = 0;
    for (const item of timeline) {
      if (item.type !== "message") continue;
      const message = item.data as ChatMessage;
      if (message.role === "user" && message.timestamp > latest) latest = message.timestamp;
    }
    return latest;
  }, [timeline]);

  // Active plans always show (newest first, as served); terminal plans show
  // only until a newer user message exists.
  const visiblePlans = useMemo(() => {
    const active = plans.filter((p) => !TERMINAL_PLAN.has(p.status));
    const terminal = plans.filter(
      (p) => TERMINAL_PLAN.has(p.status) && parseDbTime(p.updated_at) > lastUserMessageTs,
    );
    return [...active, ...terminal];
  }, [plans, lastUserMessageTs]);

  // Each plan auto-expands ONCE when first seen running, and auto-collapses
  // when we watch it reach a terminal state (already-terminal plans on first
  // fetch never expand).
  useEffect(() => {
    setExpandedIds((previous) => {
      let next: Set<string> | null = null;
      const mutate = () => (next ??= new Set(previous));
      for (const plan of plans) {
        const prevStatus = prevStatusRef.current.get(plan.id);
        const isTerminal = TERMINAL_PLAN.has(plan.status);
        if (!isTerminal && !autoExpandedRef.current.has(plan.id)) {
          autoExpandedRef.current.add(plan.id);
          mutate().add(plan.id);
        }
        if (isTerminal && prevStatus !== undefined && !TERMINAL_PLAN.has(prevStatus) && previous.has(plan.id)) {
          mutate().delete(plan.id);
        }
        prevStatusRef.current.set(plan.id, plan.status);
      }
      return next ?? previous;
    });
  }, [plans]);

  if (!sessionId || visiblePlans.length === 0) return null;

  return (
    <div className="shrink-0 space-y-1.5 px-5 pt-2" data-testid="execution-plan-panel">
      {visiblePlans.map((plan) => {
        const expanded = expandedIds.has(plan.id);
        const doneCount = plan.steps.filter((s) => DONE.has(s.status)).length;
        const failedCount = plan.steps.filter((s) => FAILED.has(s.status) || CANCELLED.has(s.status)).length;
        const runningStep = plan.steps.find((s) => RUNNING.has(s.status));
        const planRunning = !TERMINAL_PLAN.has(plan.status);

        const statusLabel = planRunning
          ? (runningStep ? t("plan.running.step", { title: runningStep.title }) : t("plan.running"))
          : plan.status === "completed"
            ? t("plan.completed")
            : t("plan.failed");

        return (
          <div
            key={plan.id}
            data-plan-id={plan.id}
            className="mx-auto w-full max-w-[1240px] rounded-xl border"
            style={{ background: "var(--surface-elevated)", borderColor: "var(--border-medium)" }}
          >
            <div className="flex h-9 w-full min-w-0 items-center">
              <button
                type="button"
                onClick={() =>
                  setExpandedIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(plan.id)) next.delete(plan.id);
                    else next.add(plan.id);
                    return next;
                  })
                }
                className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-3 pr-1 text-left"
                aria-expanded={expanded}
              >
                {planRunning ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" strokeWidth={2} />
                ) : plan.status === "completed" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-ink/55" strokeWidth={2} />
                ) : (
                  <X className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--danger)" }} strokeWidth={2} />
                )}
                <span className="shrink-0 text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                  {t("plan.title")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {plan.goal}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                  {t("plan.progress", { done: doneCount, total: plan.steps.length })}
                </span>
                {expanded
                  ? <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                  : <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />}
              </button>
              {planRunning && (
                <button
                  type="button"
                  data-testid="plan-cancel-button"
                  onClick={() => cancelPlan(plan.id)}
                  disabled={cancellingId === plan.id}
                  aria-label={t("plan.cancel")}
                  title={t("plan.cancel")}
                  className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.06] disabled:opacity-40"
                  style={{ color: "var(--text-muted)" }}
                >
                  {cancellingId === plan.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    : <X className="h-3.5 w-3.5" strokeWidth={2} />}
                </button>
              )}
            </div>

            {expanded && (
              <div className="border-t px-3 pb-2.5 pt-2" style={{ borderColor: "var(--border-subtle)" }}>
                <ol className="space-y-1">
                  {plan.steps.map((step, index) => (
                    <li key={step.id} className="flex min-w-0 items-center gap-2.5 py-0.5">
                      <StepStatusIcon status={step.status} />
                      <span
                        className={cn("min-w-0 flex-1 truncate text-[12.5px]", DONE.has(step.status) && "text-ink/45")}
                        style={DONE.has(step.status) ? undefined : { color: "var(--text-secondary)" }}
                      >
                        {index + 1}. {step.title}
                        {step.guard_reason && !DONE.has(step.status)
                          ? ` ${t("plan.step.guard_reason", { reason: guardReasonLabel(step.guard_reason) })}`
                          : ""}
                      </span>
                      {FAILED.has(step.status) && (
                        <span className="shrink-0 text-[10.5px]" style={{ color: "var(--danger)" }}>
                          {t("plan.step.failed")}
                        </span>
                      )}
                      {BLOCKED.has(step.status) && (
                        <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text-disabled)" }} title={step.blocked_reason}>
                          {t("plan.step.blocked")}
                        </span>
                      )}
                      {CANCELLED.has(step.status) && (
                        <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text-disabled)" }}>
                          {t("plan.step.cancelled")}
                        </span>
                      )}
                      {(FAILED.has(step.status) || CANCELLED.has(step.status)) && (
                        <button
                          type="button"
                          data-testid="plan-step-retry-button"
                          onClick={() => retryStep(plan.id, step.id)}
                          disabled={retryingStepId === step.id}
                          aria-label={t("plan.step.retry")}
                          title={t("plan.step.retry")}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.06] disabled:opacity-40"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {retryingStepId === step.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                            : <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                <p className="mt-1.5 truncate text-[11px]" style={{ color: "var(--text-disabled)" }}>
                  {statusLabel}
                  {failedCount > 0 && planRunning ? ` · ${t("plan.failures", { count: failedCount })}` : ""}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
