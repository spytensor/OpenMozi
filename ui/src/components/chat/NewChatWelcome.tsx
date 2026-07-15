import { lazy, Suspense } from "react";
import { BarChart3, FileText, Search, Sparkles } from "lucide-react";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale, type MessageKey } from "@/i18n";

const TaskTemplatesSurface = lazy(() => import("@/components/task-templates/TaskTemplatesSurface"));

const STARTER_CARDS: Array<{
  labelKey: MessageKey;
  promptKey: MessageKey;
  icon: typeof Sparkles;
  iconClassName: string;
}> = [
  {
    labelKey: "app.starters.office",
    promptKey: "app.starters.office.1",
    icon: Sparkles,
    iconClassName: "text-sky-400",
  },
  {
    labelKey: "app.starters.research",
    promptKey: "app.starters.research.1",
    icon: Search,
    iconClassName: "text-violet-400",
  },
  {
    labelKey: "app.starters.documents",
    promptKey: "app.starters.documents.1",
    icon: FileText,
    iconClassName: "text-emerald-400",
  },
  {
    labelKey: "app.starters.data",
    promptKey: "app.starters.data.2",
    icon: BarChart3,
    iconClassName: "text-orange-400",
  },
];

export function NewChatWelcome({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  const { t } = useLocale();

  return (
    <div className="w-full text-center" data-testid="new-chat-welcome">
      <MoziAvatar size={48} className="mb-5 opacity-65" />
      <h1 className="text-[32px] font-medium tracking-[-0.03em] text-ink/88 sm:text-[36px]">
        {t("app.emptyHeadline")}
      </h1>
      <p className="mt-2 text-[13px] text-ink/42">{t("app.emptySubtitle")}</p>

      <div className="mx-auto mt-8 grid max-w-[860px] grid-cols-2 gap-3 text-left sm:grid-cols-4" data-testid="starter-card-grid">
        {STARTER_CARDS.map(({ labelKey, promptKey, icon: Icon, iconClassName }) => {
          const prompt = t(promptKey);
          return (
            <button
              key={promptKey}
              type="button"
              onClick={() => onSelectPrompt(prompt)}
              aria-label={prompt}
              data-testid="starter-card"
              className="group flex h-[132px] min-w-0 flex-col justify-between rounded-2xl border px-4 py-4 text-left transition-[background-color,border-color,transform] hover:-translate-y-0.5 hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              style={{ borderColor: "var(--border-subtle)", background: "transparent" }}
            >
              <Icon className={`h-[18px] w-[18px] ${iconClassName}`} aria-hidden="true" />
              <span className="line-clamp-2 text-[13px] font-medium leading-[1.45] text-ink/78">
                {prompt}
              </span>
              <span className="sr-only">{t(labelKey)}</span>
            </button>
          );
        })}
      </div>

      <Suspense fallback={<div className="mx-auto mt-4 h-5 w-28 animate-pulse rounded bg-ink/[0.035]" />}>
        <TaskTemplatesSurface />
      </Suspense>
    </div>
  );
}
