import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ExecutionMode } from "./types.js";

interface ProviderStrategy {
  apiKey: (env: NodeJS.ProcessEnv) => string | null;
  defaultModel: string;
  create: (apiKey: string, modelId: string) => LanguageModel;
}

const readKey = (value: string | undefined) => {
  const key = (value ?? "").trim();
  return key && !key.startsWith("your_") ? key : null;
};

const PROVIDERS = {
  google: {
    apiKey: (env) => readKey(env.GOOGLE_GENERATIVE_AI_API_KEY),
    defaultModel: "gemini-2.5-flash",
    create: (apiKey, modelId) => createGoogleGenerativeAI({ apiKey })(modelId),
  },
  openai: {
    apiKey: (env) => readKey(env.OPENAI_API_KEY),
    defaultModel: "gpt-4o-mini",
    create: (apiKey, modelId) => createOpenAI({ apiKey })(modelId),
  },
} satisfies Record<string, ProviderStrategy>;

export type SupportedProvider = keyof typeof PROVIDERS;

export interface ModelConfig {
  provider: SupportedProvider | null;
  modelId: string;
  apiKey: string | null;
}

const DETERMINISTIC: ModelConfig = {
  provider: null,
  modelId: "deterministic",
  apiKey: null,
};

const isProvider = (name: string): name is SupportedProvider =>
  name in PROVIDERS;

export function resolveModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModelConfig {
  if (env.FORCE_DETERMINISTIC === "true") return DETERMINISTIC;

  const preferred = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const candidates = Object.keys(PROVIDERS) as SupportedProvider[];
  if (isProvider(preferred)) candidates.unshift(preferred);

  for (const provider of candidates) {
    const apiKey = PROVIDERS[provider].apiKey(env);
    if (apiKey)
      return {
        provider,
        modelId: env.AI_MODEL || PROVIDERS[provider].defaultModel,
        apiKey,
      };
  }
  return DETERMINISTIC;
}

export const executionModeOf = (config: ModelConfig): ExecutionMode =>
  config.provider ? "vercel-ai-sdk" : "deterministic-fallback";

export function createLanguageModel({
  provider,
  apiKey,
  modelId,
}: ModelConfig): LanguageModel | null {
  return provider && apiKey
    ? PROVIDERS[provider].create(apiKey, modelId)
    : null;
}
