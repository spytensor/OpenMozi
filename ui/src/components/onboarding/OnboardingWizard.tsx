import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, Eye, EyeOff, Loader2, RotateCw } from "lucide-react";
import MoziAvatar from "@/components/MoziAvatar";
import { ACCESS_MODE_LEVELS, PERMISSION_META, type PermissionLevel } from "@/components/chat/PermissionChip";
import { useApi } from "@/hooks/useApi";
import { LOCALES, useLocale, type Locale, type MessageKey } from "@/i18n";
import type { CatalogProvider } from "@/lib/model-catalog";
import {
  readDefaultPermissionLevel,
  writeDefaultPermissionLevel,
} from "@/lib/permission-default";

interface OnboardingWizardProps {
  onComplete: () => void;
}

interface CurrentUserResponse {
  user?: {
    name?: string | null;
    display_name?: string | null;
    email?: string | null;
  } | null;
  name?: string | null;
  display_name?: string | null;
  email?: string | null;
}

interface ApiKeyEntry {
  provider: string;
  key_hint?: string | null;
}

interface ProvidersResponse {
  providers?: CatalogProvider[];
}

type StepKey = "basic" | "model" | "permission" | "complete";

const STEPS: Array<{
  key: StepKey;
  railKey: MessageKey;
  titleKey: MessageKey;
  subtitleKey: MessageKey;
}> = [
  {
    key: "basic",
    railKey: "onboarding.rail.basic",
    titleKey: "onboarding.step.basic.title",
    subtitleKey: "onboarding.step.basic.subtitle",
  },
  {
    key: "model",
    railKey: "onboarding.rail.model",
    titleKey: "onboarding.step.model.title",
    subtitleKey: "onboarding.step.model.subtitle",
  },
  {
    key: "permission",
    railKey: "onboarding.rail.permission",
    titleKey: "onboarding.step.permission.title",
    subtitleKey: "onboarding.step.permission.subtitle",
  },
  {
    key: "complete",
    railKey: "onboarding.rail.complete",
    titleKey: "onboarding.step.complete.title",
    subtitleKey: "onboarding.step.complete.subtitle",
  },
];

function userNameFromResponse(data: CurrentUserResponse | null): string {
  const user = data?.user ?? data;
  return user?.name || user?.display_name || user?.email || "";
}

function providerModelId(provider: CatalogProvider | undefined): string {
  return provider?.defaultModel || provider?.models?.[0]?.id || "";
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { locale, setLocale, t } = useLocale();
  const { get, post } = useApi();
  const [step, setStep] = useState(0);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [readyProviderId, setReadyProviderId] = useState<string | null>(null);
  const [modelSkipped, setModelSkipped] = useState(false);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>(() => readDefaultPermissionLevel() ?? "L1_READ_WRITE");
  const [permissionSkipped, setPermissionSkipped] = useState(false);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId) ?? providers[0],
    [providerId, providers],
  );
  const configuredProviders = useMemo(() => new Set(keys.map((entry) => entry.provider)), [keys]);
  const providerReady = !!selectedProvider && (readyProviderId === selectedProvider.id || configuredProviders.has(selectedProvider.id));

  const loadInitialState = useCallback(async () => {
    setLoadingProfile(true);
    setLoadingProviders(true);
    setProfileError(null);
    setProviderError(null);
    const [userResult, providerResult, keysResult] = await Promise.all([
      get<CurrentUserResponse>("/api/users/me"),
      get<ProvidersResponse>("/api/providers"),
      get<{ keys: ApiKeyEntry[] }>("/api/keys"),
    ]);

    if (userResult.error) {
      setProfileError(userResult.error);
    } else {
      const nextName = userNameFromResponse(userResult.data);
      if (nextName) setName((existing) => existing || nextName);
    }
    setLoadingProfile(false);

    if (providerResult.error || keysResult.error) {
      setProviderError(providerResult.error ? t("models.loadError") : keysResult.error);
      setProviders([]);
      setKeys([]);
    } else {
      const nextProviders = providerResult.data?.providers ?? [];
      const nextKeys = keysResult.data?.keys ?? [];
      setProviders(nextProviders);
      setKeys(nextKeys);
      setProviderId((existing) => existing || nextKeys[0]?.provider || nextProviders[0]?.id || "");
      if (nextKeys[0]?.provider) setReadyProviderId(nextKeys[0].provider);
    }
    setLoadingProviders(false);
  }, [get, t]);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  const goNext = () => {
    setCompletionError(null);
    if (STEPS[step].key === "permission" && !permissionSkipped) {
      writeDefaultPermissionLevel(permissionLevel);
    }
    if (STEPS[step].key === "model") {
      setModelSkipped(!providerReady);
    }
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  const skipStep = () => {
    if (STEPS[step].key === "model") setModelSkipped(true);
    if (STEPS[step].key === "permission") setPermissionSkipped(true);
    setCompletionError(null);
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  const testProvider = async () => {
    if (!selectedProvider) return;
    const model = providerModelId(selectedProvider);
    if (!model) {
      setProviderError(t("common.unavailable"));
      return;
    }
    setTestingProvider(true);
    setProviderError(null);
    setModelSkipped(false);
    const normalizedKey = apiKey.trim();
    if (normalizedKey) {
      const saveResult = await post(`/api/keys/${selectedProvider.id}`, { key: normalizedKey });
      if (saveResult.error) {
        setTestingProvider(false);
        setProviderError(saveResult.error);
        return;
      }
      setKeys((previous) => {
        const rest = previous.filter((entry) => entry.provider !== selectedProvider.id);
        return [...rest, { provider: selectedProvider.id }];
      });
      setApiKey("");
      setShowKey(false);
    }
    const checkResult = await post<{ ok: boolean; error?: string }>(`/api/providers/${selectedProvider.id}/check`, { model });
    setTestingProvider(false);
    if (checkResult.data?.ok) {
      setReadyProviderId(selectedProvider.id);
      return;
    }
    setProviderError(checkResult.data?.error || checkResult.error || t("common.unavailable"));
  };

  const choosePermission = (level: PermissionLevel) => {
    setPermissionSkipped(false);
    setPermissionLevel(level);
    writeDefaultPermissionLevel(level);
  };

  const handleComplete = async (allowBypass = false) => {
    setSaving(true);
    setCompletionError(null);
    const result = await post("/api/onboarding/complete", {
      name: name.trim(),
      provider: modelSkipped ? null : selectedProvider?.id ?? null,
      skills: [],
      permission_level: permissionSkipped ? null : permissionLevel,
    });
    setSaving(false);
    if (result.error) {
      if (allowBypass) {
        onComplete();
        return;
      }
      setCompletionError(result.error);
      return;
    }
    onComplete();
  };

  const currentStep = STEPS[step];
  const isLast = currentStep.key === "complete";

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4 py-8">
      <div className="grid w-full max-w-[920px] overflow-hidden rounded-lg border border-ink/[0.07] bg-surface shadow-2xl md:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-b border-ink/[0.06] bg-ink/[0.015] p-4 md:border-b-0 md:border-r">
          <div className="flex items-center gap-2">
            <MoziAvatar size={28} />
            <span className="text-[13px] font-semibold text-ink/82">{t("sidebar.brand")}</span>
          </div>
          <nav className="mt-6 flex gap-1 md:flex-col">
            {STEPS.map((item, index) => {
              const active = index === step;
              const complete = index < step;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setStep(index)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left md:flex-none"
                  style={{
                    background: active ? "var(--surface-active)" : "transparent",
                    color: active ? "var(--text-primary)" : "rgb(var(--ink-rgb) / 0.48)",
                  }}
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px]"
                    style={{
                      background: active || complete ? "var(--accent)" : "rgb(var(--ink-rgb) / 0.08)",
                      color: active || complete ? "var(--accent-fg)" : "rgb(var(--ink-rgb) / 0.5)",
                    }}
                  >
                    {complete ? <Check className="h-3 w-3" /> : index + 1}
                  </span>
                  <span className="truncate text-[12.5px] font-medium">{t(item.railKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="flex min-h-[560px] flex-col p-5 md:p-7">
          <header>
            <h1
              className="text-[24px] font-semibold tracking-normal text-ink/88"
              style={currentStep.key === "basic" ? { fontFamily: '"Kaiti SC","STKaiti",serif' } : undefined}
            >
              {t(currentStep.titleKey)}
            </h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/42">{t(currentStep.subtitleKey)}</p>
          </header>

          <div className="min-h-0 flex-1 py-7">
            {currentStep.key === "basic" && (
              <div className="max-w-[520px] space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] text-ink/42">{t("onboarding.name.label")}</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("onboarding.name.placeholder")}
                    className="h-10 w-full rounded-md border px-3 text-[13px] outline-none"
                    style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] text-ink/42">{t("onboarding.language.label")}</span>
                  <select
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as Locale)}
                    className="h-10 w-full rounded-md border px-3 text-[13px] outline-none"
                    style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                  >
                    {LOCALES.map((option) => (
                      <option key={option} value={option}>
                        {option === "zh-CN" ? t("settings.language.zhCN") : t("settings.language.en")}
                      </option>
                    ))}
                  </select>
                </label>
                {loadingProfile && (
                  <InlineStatus icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} label={t("common.loading")} />
                )}
                {profileError && (
                  <InlineError error={profileError} onRetry={loadInitialState} retryLabel={t("common.retry")} />
                )}
              </div>
            )}

            {currentStep.key === "model" && (
              <div className="max-w-[560px] space-y-4">
                {loadingProviders ? (
                  <InlineStatus icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} label={t("onboarding.provider.loading")} />
                ) : providers.length === 0 ? (
                  <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-4 text-[13px] text-ink/44">
                    {t("onboarding.provider.none")}
                  </div>
                ) : (
                  <>
                    <label className="block">
                      <span className="mb-1.5 block text-[11.5px] text-ink/42">{t("onboarding.provider.label")}</span>
                      <select
                        value={selectedProvider?.id ?? ""}
                        onChange={(event) => {
                          setProviderId(event.target.value);
                          setProviderError(null);
                        }}
                        className="h-10 w-full rounded-md border px-3 text-[13px] outline-none"
                        style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11.5px] text-ink/42">{t("onboarding.provider.keyLabel")}</span>
                      <span className="relative block">
                        <input
                          type={showKey ? "text" : "password"}
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder={t("onboarding.provider.keyPlaceholder")}
                          className="h-10 w-full rounded-md border px-3 pr-10 font-mono text-[13px] outline-none"
                          style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((value) => !value)}
                          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink/42 hover:bg-ink/[0.05] hover:text-ink/72"
                        >
                          {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </span>
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={testProvider}
                        disabled={testingProvider || !selectedProvider}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                        style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                      >
                        {testingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        {providerReady ? t("onboarding.provider.testAgain") : t("onboarding.provider.saveAndTest")}
                      </button>
                      {providerReady && (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-success">
                          <span className="h-2 w-2 rounded-full bg-success" />
                          {t("onboarding.provider.ready")}
                        </span>
                      )}
                    </div>
                  </>
                )}
                {providerError && (
                  <InlineError error={providerError} onRetry={loadInitialState} retryLabel={t("onboarding.provider.retry")} />
                )}
                <p className="text-[12px] leading-5 text-ink/35">{t("onboarding.provider.skipNote")}</p>
              </div>
            )}

            {currentStep.key === "permission" && (
              <div className="grid max-w-[640px] gap-3 sm:grid-cols-2">
                {ACCESS_MODE_LEVELS.map((level) => {
                  const meta = PERMISSION_META[level];
                  const PermIcon = meta.icon;
                  const active = !permissionSkipped && level === permissionLevel;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => choosePermission(level)}
                      className="min-h-[116px] rounded-lg border p-3 text-left transition-colors"
                      style={{
                        background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "rgb(var(--ink-rgb) / 0.018)",
                        borderColor: active ? "color-mix(in srgb, var(--accent) 42%, transparent)" : "rgb(var(--ink-rgb) / 0.07)",
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <PermIcon className="h-4 w-4 shrink-0 text-ink/70" strokeWidth={1.75} />
                        <span className="text-[13px] font-semibold text-ink/82">{t(meta.nameKey)}</span>
                        {active && <Check className="ml-auto h-3.5 w-3.5 text-accent" />}
                      </span>
                      <span className="mt-2 block text-[12px] leading-5 text-ink/42">{t(meta.descriptionKey)}</span>
                    </button>
                  );
                })}
                <p className="sm:col-span-2 text-[12px] leading-5 text-ink/35">
                  {t("onboarding.permission.localDefault")}
                </p>
                <p className="sm:col-span-2 text-[12px] leading-5 text-ink/35">
                  {t("onboarding.permission.skipNote")}
                </p>
              </div>
            )}

            {currentStep.key === "complete" && (
              <div className="max-w-[620px] space-y-4">
                <section className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-4">
                  <h2 className="text-[13px] font-semibold text-ink/78">{t("onboarding.complete.summary")}</h2>
                  <div className="mt-3 grid gap-2 text-[12.5px]">
                    <SummaryRow label={t("onboarding.complete.name")} value={name.trim() || t("onboarding.complete.notProvided")} />
                    <SummaryRow label={t("onboarding.complete.language")} value={locale === "zh-CN" ? t("settings.language.zhCN") : t("settings.language.en")} />
                    <SummaryRow label={t("onboarding.complete.provider")} value={modelSkipped ? t("onboarding.complete.skipped") : selectedProvider?.name ?? t("onboarding.complete.skipped")} />
                    <SummaryRow
                      label={t("onboarding.complete.permission")}
                      value={permissionSkipped ? t("onboarding.complete.skipped") : t(PERMISSION_META[permissionLevel].nameKey)}
                    />
                  </div>
                </section>
                <section className="rounded-lg border border-accent/20 bg-accent/10 p-4">
                  <div className="text-[11.5px] uppercase text-ink/40">{t("onboarding.complete.firstPromptLabel")}</div>
                  <p className="mt-1 text-[14px] leading-6 text-ink/82">{t("onboarding.complete.firstPrompt")}</p>
                </section>
                {completionError && (
                  <InlineError
                    error={completionError}
                    onRetry={() => void handleComplete(false)}
                    retryLabel={t("common.retry")}
                  />
                )}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-ink/[0.06] pt-4">
            <button
              type="button"
              onClick={() => setStep((value) => Math.max(value - 1, 0))}
              disabled={step === 0 || saving}
              className="inline-flex h-9 items-center rounded-md px-3 text-[12.5px] text-ink/52 transition-colors hover:bg-ink/[0.05] hover:text-ink/78 disabled:opacity-35"
            >
              {t("onboarding.back")}
            </button>
            <div className="flex items-center gap-2">
              {!isLast && (
                <button
                  type="button"
                  onClick={skipStep}
                  className="inline-flex h-9 items-center rounded-md px-3 text-[12.5px] text-ink/48 transition-colors hover:bg-ink/[0.05] hover:text-ink/78"
                >
                  {t("onboarding.skip")}
                </button>
              )}
              {isLast && (
                <button
                  type="button"
                  onClick={() => void handleComplete(true)}
                  disabled={saving}
                  className="inline-flex h-9 items-center rounded-md px-3 text-[12.5px] text-ink/48 transition-colors hover:bg-ink/[0.05] hover:text-ink/78 disabled:opacity-50"
                >
                  {t("onboarding.complete.skipSetup")}
                </button>
              )}
              <button
                type="button"
                onClick={isLast ? () => void handleComplete(false) : goNext}
                disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isLast ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {isLast ? t("onboarding.getStarted") : t("onboarding.next")}
              </button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function InlineStatus({ icon, label }: { icon: JSX.Element; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink/[0.06] bg-ink/[0.018] px-3 py-2 text-[12.5px] text-ink/44">
      {icon}
      {label}
    </div>
  );
}

function InlineError({
  error,
  onRetry,
  retryLabel,
}: {
  error: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-warning">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 overflow-wrap-anywhere">{error}</span>
      <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 underline underline-offset-4">
        <RotateCw className="h-3 w-3" />
        {retryLabel}
      </button>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
      <span className="text-ink/38">{label}</span>
      <span className="min-w-0 truncate text-ink/72">{value}</span>
    </div>
  );
}
