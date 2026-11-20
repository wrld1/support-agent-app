import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ExecutionMode } from './types.js';

export type SupportedProvider = 'google' | 'openai';

export interface ModelConfig {
  provider: SupportedProvider | null;
  modelId: string;
  apiKey: string | null;
}

const DETERMINISTIC: ModelConfig = { provider: null, modelId: 'deterministic', apiKey: null };

const readKey = (value: string | undefined) => {
  const key = (value ?? '').trim();
  return key && !key.startsWith('your_') ? key : null;
};

export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  if (env.FORCE_DETERMINISTIC === 'true') return DETERMINISTIC;

  const preferred = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const googleKey = readKey(env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY);
  const openaiKey = readKey(env.OPENAI_API_KEY);

  if (openaiKey && (preferred === 'openai' || !googleKey)) {
    return { provider: 'openai', modelId: env.AI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini', apiKey: openaiKey };
  }
  if (googleKey) {
    return { provider: 'google', modelId: env.AI_MODEL || 'gemini-2.5-flash', apiKey: googleKey };
  }
  return DETERMINISTIC;
}

export const executionModeOf = (config: ModelConfig): ExecutionMode =>
  config.provider ? 'vercel-ai-sdk' : 'deterministic-fallback';

export function createLanguageModel({ provider, apiKey, modelId }: ModelConfig): LanguageModel | null {
  if (!apiKey) return null;
  if (provider === 'google') return createGoogleGenerativeAI({ apiKey })(modelId);
  if (provider === 'openai') return createOpenAI({ apiKey })(modelId);
  return null;
}
