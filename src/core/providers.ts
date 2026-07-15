/**
 * Provider Registry — Single source of truth for all LLM provider definitions.
 *
 * Responsibilities:
 * - Provider/model catalog metadata (via provider-catalog.ts)
 * - API mode routing metadata (adapter selection)
 * - API key normalization for `mozi onboard` + onboarding discovery
 * - Backward-compatible env/config migration helpers (via legacy-migration.ts)
 */

import {
  PROVIDERS,
  WIZARD_PROVIDER_IDS,
  parseApiKeysList,
  resolveNumberedApiKeys,
  resolveForwardCompatModel,
} from './provider-catalog.js';
import { isSafeCustomModelId } from './model-discovery.js';

// Re-export catalog + migration for consumers that import from providers.js
export { PROVIDERS, WIZARD_PROVIDER_IDS } from './provider-catalog.js';
export { migrateEnvVars } from './legacy-migration.js';
export type { MigrationResult } from './legacy-migration.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderApiMode =
  | 'openai-compat'
  | 'anthropic'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'google-generative-ai'
  | 'bedrock-converse-stream'
  | 'ollama-native'
  | 'cli-pipe';

/** Declarative backend config for CLI-pipe providers (inspired by OpenClaw). */
export interface CliBackendConfig {
  /** CLI executable name (e.g. "claude", "codex", "gemini"). */
  command: string;
  /** Base args passed on every invocation. */
  args: string[];
  /** Args used when resuming a session (replaces `args`). */
  resumeArgs?: string[];
  /** How the prompt is passed: as the last CLI arg, or via stdin. */
  input: 'arg' | 'stdin';
  /** How to parse stdout: single JSON object, newline-delimited JSON, or raw text. */
  output: 'json' | 'jsonl' | 'text';
  /** Auto-switch to stdin when prompt exceeds this many characters. */
  maxPromptArgChars?: number;
  /** CLI flag for specifying the model (e.g. "--model"). */
  modelArg?: string;
  /** @deprecated — removed. CLI providers must respect user-configured model IDs. */
  fixedModel?: never;
  /** Inline system prompt into the user prompt when no dedicated system arg exists. */
  inlineSystemPrompt?: boolean;
  /** Optional CLI flag for prompt text in non-interactive/headless mode (e.g. "-p"). */
  promptArg?: string;
  /** Map MOZI model IDs → CLI-specific model names. */
  modelAliases?: Record<string, string>;
  /** CLI flag for system prompt (e.g. "--append-system-prompt"). */
  systemPromptArg?: string;
  /** How to encode system prompt value for `systemPromptArg`. */
  systemPromptFormat?: 'raw' | 'codex-config-instructions';
  /** When to include system prompt: only on first turn, or every turn. */
  systemPromptWhen?: 'first' | 'always';
  /** CLI flag for session/conversation ID (e.g. "--session-id"). */
  sessionArg?: string;
  /** Session handling mode: always create, reuse existing, or never. */
  sessionMode?: 'always' | 'existing' | 'none';
  /** JSON field path(s) to extract session ID from CLI output. */
  sessionIdFields?: string[];
  /** CLI flag for image path (vision support). */
  imageArg?: string;
  /** Optional CLI flag for MCP config path when the CLI supports MCP client mode. */
  mcpConfigArg?: string;
  /** Optional CLI flag to require strict MCP config handling. */
  strictMcpConfigFlag?: string;
  /** Per-invocation timeout in ms (default 120_000). */
  timeoutMs?: number;
}

export interface ModelDef {
  id: string;
  name: string;
  tier: 'high' | 'mid' | 'low';
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  reasoning: boolean;        // reasoning model — temperature not supported
  inputCostPer1M?: number;   // USD per 1M input tokens
  outputCostPer1M?: number;  // USD per 1M output tokens
  cacheReadCostPer1M?: number; // USD per 1M provider-managed cache-read tokens
  cacheWriteCostPer1M?: number; // USD per 1M provider-managed cache-write tokens
}

export interface RegionDef {
  id: string;
  name: string;
  baseUrl: string;
}

export interface ForwardCompatRule {
  pattern: RegExp;
  templateModel: string;
}

export interface ProviderEnvDef {
  /** Canonical env var for single-key setup */
  primaryKey: string;
  /** Backward-compatible aliases (e.g. GOOGLE_API_KEY for Gemini) */
  keyAliases: string[];
  /** Prefixes used by key-combo envs (LIVE/API_KEYS/API_KEY_N) */
  keyPrefixes: string[];
  /** Optional explicit base URL env vars in priority order */
  baseUrlKeys: string[];
}

export interface ProviderDef {
  id: string;
  name: string;
  /** Backward-compatible alias for existing callers/tests */
  envKey: string;
  baseUrl: string;
  /** Backward-compatible alias for existing callers/tests */
  apiType: ProviderApiMode;
  apiMode: ProviderApiMode;
  defaultModel: string;
  models: ModelDef[];
  hint?: string;
  placeholder?: string;
  /** Regional endpoint variants (e.g. MiniMax global vs China) */
  regions?: RegionDef[];
  /** Env resolution metadata */
  env: ProviderEnvDef;
  /** Unknown-but-related model fallback template rules */
  forwardCompat?: ForwardCompatRule[];
  /** Whether detectConfiguredProviders should auto-include this provider */
  autoDetect: boolean;
  /** CLI backend config (only for apiMode === 'cli-pipe'). */
  cliBackend?: CliBackendConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get a provider definition by ID */
export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS[id];
}

/** Get all registered providers */
export function getAllProviders(): ProviderDef[] {
  return Object.values(PROVIDERS);
}

/** Get providers suitable for the setup wizard */
export function getWizardProviders(): ProviderDef[] {
  return WIZARD_PROVIDER_IDS
    .map(id => PROVIDERS[id])
    .filter((provider): provider is ProviderDef => Boolean(provider));
}

/** Coding-agent CLI transports are managed workers, not chat-role providers. */
export function isChatRoleEligibleProvider(providerOrId: ProviderDef | string | undefined): boolean {
  const def = typeof providerOrId === 'string' ? getProvider(providerOrId) : providerOrId;
  return Boolean(def && def.apiMode !== 'cli-pipe');
}

/** Providers that can be used for brain/light model roles. */
export function getChatRoleEligibleProviders(): ProviderDef[] {
  return getAllProviders().filter(isChatRoleEligibleProvider);
}

/** Resolve API keys for a provider using normalized env precedence. */
export function resolveApiKeys(providerId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const def = PROVIDERS[providerId];
  if (!def) return [];

  const seen = new Set<string>();
  const resolved: string[] = [];

  const addValue = (value: string | undefined) => {
    const trimmed = (value || '').trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  };

  // 1) Per-provider live override: MOZI_LIVE_<PROVIDER>_KEY
  for (const prefix of def.env.keyPrefixes) {
    addValue(env[`MOZI_LIVE_${prefix}_KEY`]);
  }

  // 2) Combined list: <PROVIDER>_API_KEYS (comma/semicolon)
  for (const prefix of def.env.keyPrefixes) {
    for (const value of parseApiKeysList(env[`${prefix}_API_KEYS`])) {
      addValue(value);
    }
  }

  // 3) Primary + aliases
  addValue(env[def.env.primaryKey]);
  for (const alias of def.env.keyAliases) {
    addValue(env[alias]);
  }

  // 4) Numbered fallback: <PROVIDER>_API_KEY_1, _2, ...
  for (const prefix of def.env.keyPrefixes) {
    for (const value of resolveNumberedApiKeys(prefix, env)) {
      addValue(value);
    }
  }

  return resolved;
}

/** Resolve the first (highest-priority) API key for a provider. */
export function resolveApiKey(
  providerId: string,
  configProviders?: Record<string, { apikey?: string }>,
): string | undefined {
  // Config override (highest priority)
  const configEntry = configProviders?.[providerId];
  if (configEntry?.apikey?.trim()) return configEntry.apikey.trim();

  return resolveApiKeys(providerId)[0];
}

/** Resolve base URL for a provider — config override > env var override > registry default. */
export function resolveBaseUrl(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
  configProviders?: Record<string, { baseurl?: string }>,
): string {
  // Config override (highest priority)
  const configEntry = configProviders?.[providerId];
  if (configEntry?.baseurl?.trim()) return configEntry.baseurl.trim();

  const def = PROVIDERS[providerId];
  if (!def) return '';

  for (const envKey of def.env.baseUrlKeys) {
    const value = (env[envKey] || '').trim();
    if (value) {
      return value;
    }
  }

  return def.baseUrl;
}

/** Resolve API mode for adapter routing. */
export function resolveApiMode(providerId: string): ProviderApiMode | undefined {
  return PROVIDERS[providerId]?.apiMode;
}

/** Get a specific model definition from a provider (supports forward-compat clone). */
export function getModel(providerId: string, modelId: string): ModelDef | undefined {
  const def = PROVIDERS[providerId];
  if (!def) return undefined;

  const exact = def.models.find(m => m.id === modelId);
  if (exact) {
    return exact;
  }

  return resolveForwardCompatModel(def, modelId);
}

/** Resolve an operator-selected live/manual model with conservative capabilities. */
export function resolveRuntimeModel(providerId: string, modelId: string, options: { allowUnknown?: boolean } = {}): ModelDef | undefined {
  const known = getModel(providerId, modelId);
  if (known) return known;
  const provider = PROVIDERS[providerId];
  const trimmed = modelId.trim();
  if (!options.allowUnknown || !provider || provider.apiMode === 'cli-pipe' || !isSafeCustomModelId(trimmed)) return undefined;
  return {
    id: trimmed,
    name: trimmed,
    tier: 'low',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    supportsTools: false,
    supportsStreaming: true,
    supportsVision: false,
    reasoning: false,
  };
}

/** Detect which providers have API keys configured in process.env. */
export function detectConfiguredProviders(env: NodeJS.ProcessEnv = process.env): ProviderDef[] {
  return getAllProviders().filter(def => def.autoDetect && resolveApiKeys(def.id, env).length > 0);
}

/**
 * Get providers that have vision-capable models AND valid API keys.
 * Returns entries ordered: openai-compat first (broadest raw-fetch support),
 * then anthropic-format providers.
 */
export function getVisionCapableProviders(): Array<{
  provider: string;
  model: string;
  apiMode: ProviderApiMode;
  baseUrl: string;
}> {
  const result: Array<{ provider: string; model: string; apiMode: ProviderApiMode; baseUrl: string }> = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (!resolveApiKey(id)) continue;
    const visionModel = def.models.find(m => m.supportsVision);
    if (!visionModel) continue;
    result.push({
      provider: id,
      model: visionModel.id,
      apiMode: def.apiMode,
      baseUrl: resolveBaseUrl(id),
    });
  }
  // Prefer openai-compat / openai-responses (raw-fetch friendly) over anthropic
  result.sort((a, b) => {
    const aScore = a.apiMode === 'anthropic' ? 1 : 0;
    const bScore = b.apiMode === 'anthropic' ? 1 : 0;
    return aScore - bScore;
  });
  return result;
}
