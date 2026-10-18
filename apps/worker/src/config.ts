import type { ModelNames } from "./types.ts";

export const LIMITS = {
  researchTurns: 18,
  searches: 8,
  reads: 6,
  claims: 20,
  // Pages fetched implicitly to verify a quote from a page the agent never read.
  autoExtracts: 4,
  counterSearches: 6,
  checkerTurns: 3,
  // Workers free plan allows 50 subrequests per invocation; keep headroom.
  subrequests: 46,
  readCharsToModel: 6000,
  storedPageChars: 150_000,
} as const;

// Milliseconds since run start.
export const DEADLINES = {
  research: 70_000,
  factcheck: 100_000,
  run: 150_000,
} as const;

export const TIMEOUTS = {
  llm: 60_000,
  tavily: 20_000,
} as const;

export type Role = keyof ModelNames;

export interface RoleConfig {
  model: string;
  baseURL: string;
}

export function roleConfigs(env: Env): Record<Role, RoleConfig> {
  const base = env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1";
  return {
    research: { model: env.NEBIUS_MODEL_RESEARCH, baseURL: env.NEBIUS_BASE_URL_RESEARCH || base },
    check: { model: env.NEBIUS_MODEL_CHECK || env.NEBIUS_MODEL_RESEARCH, baseURL: env.NEBIUS_BASE_URL_CHECK || base },
    write: { model: env.NEBIUS_MODEL_WRITE || env.NEBIUS_MODEL_RESEARCH, baseURL: env.NEBIUS_BASE_URL_WRITE || base },
  };
}

export function modelNames(env: Env): ModelNames {
  const r = roleConfigs(env);
  return { research: r.research.model, check: r.check.model, write: r.write.model };
}

// Nemotron otherwise reasons for thousands of tokens before the first visible word, which can
// exhaust the writer's max_tokens; the writer only rephrases already verified claims.
// NEBIUS_EXTRA_BODY overrides these per-role defaults.
const ROLE_EXTRA_BODY: Partial<Record<Role, Record<string, unknown>>> = {
  write: { chat_template_kwargs: { enable_thinking: false } },
};

export function roleExtraBody(env: Env, role: Role): Record<string, unknown> {
  return { ...ROLE_EXTRA_BODY[role], ...extraBody(env) };
}

function extraBody(env: Env): Record<string, unknown> {
  if (!env.NEBIUS_EXTRA_BODY) return {};
  try {
    const parsed: unknown = JSON.parse(env.NEBIUS_EXTRA_BODY);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    console.warn(JSON.stringify({ msg: "NEBIUS_EXTRA_BODY is not valid JSON; ignoring" }));
    return {};
  }
}
