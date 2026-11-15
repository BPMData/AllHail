import type { PromptMode } from '../shared/prompts.ts';

export type ReasoningConfig =
  | { enabled: false }
  | { effort: 'low' | 'medium' | 'high'; exclude?: boolean };

export type ModelStep = {
  model: string;
  reasoning?: ReasoningConfig;
};

export const VISION_MODEL_CHAINS: Record<PromptMode, readonly ModelStep[]> = {
  // Quick look (mostly students, speed matters)
  describe: [
    { model: 'anthropic/claude-haiku-5.5', reasoning: { enabled: false } },
    { model: 'google/gemini-3.5-flash-lite' },
    { model: 'z-ai/glm-5.3-flash' },
  ],
  // Full detail (students and teachers)
  detail: [
    { model: 'z-ai/glm-5.3-flash' },
    { model: 'anthropic/claude-haiku-5.5', reasoning: { effort: 'low', exclude: true } },
    { model: 'anthropic/claude-haiku-5.5', reasoning: { enabled: false } },
    { model: 'google/gemini-3.5-flash-lite' },
  ],
};

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const PER_MODEL_TIMEOUT_MS = 30_000;
export const TOTAL_REQUEST_TIMEOUT_MS = 90_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const RATE_LIMIT_MAX_REQUESTS = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;
