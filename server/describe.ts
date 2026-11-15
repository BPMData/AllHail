import type { Request, Response } from 'express';
import { PROMPTS, type PromptMode } from '../shared/prompts.ts';
import { strings } from '../shared/strings.ts';
import { createRateLimiter, type RateLimiter } from './rateLimit.ts';
import {
  MAX_IMAGE_BYTES,
  OPENROUTER_URL,
  PER_MODEL_TIMEOUT_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  TOTAL_REQUEST_TIMEOUT_MS,
  VISION_MODEL_CHAINS,
  type ModelStep,
} from './visionConfig.ts';

const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

const REFUSAL_PATTERNS = [
  /^(?:i['’]m\s+sorry,?\s*(?:but\s+)?)?i\s+(?:can['’]?t|cannot|am\s+unable\s+to)\s+(?:help|assist|comply|fulfill|describe|process|analyze|read)\b/i,
  /^sorry,?\s+(?:but\s+)?i\s+(?:can['’]?t|cannot)\b/i,
  /^as\s+an\s+ai\b.*\b(?:cannot|can['’]?t|unable)\b/i,
  /\bi\s+(?:can['’]?t|cannot)\s+help\s+with\s+that\b/i,
  /\b(?:violates|against)\s+(?:my|our)\s+(?:safety|usage|content)\s+(?:policy|guidelines)\b/i,
];

export function isRefusalText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Refusals are short or start directly with a refusal statement.
  if (trimmed.length > 500) {
    const firstSentence = trimmed.split(/[.!?\n]/, 1)[0] ?? '';
    return REFUSAL_PATTERNS.some((pattern) => pattern.test(firstSentence.trim()));
  }
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function decodeImageByteLength(dataUrl: string): number | null {
  const match = IMAGE_DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const compactBase64 = match[1].replace(/\s+/g, '');
  if (!compactBase64) return 0;
  return Buffer.from(compactBase64, 'base64').byteLength;
}

export type DescribeDeps = {
  getApiKey?: () => string | undefined;
  fetchFn?: typeof fetch;
  chains?: Record<PromptMode, readonly ModelStep[]>;
  perModelTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxImageBytes?: number;
  rateLimiter?: RateLimiter;
  now?: () => number;
};

type OpenRouterResponse = {
  error?: { message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
};

type AttemptOutcome =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: string; timedOutTotal: boolean };

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

async function callSingleModel({
  apiKey,
  step,
  mode,
  imageDataUrl,
  timeoutMs,
  totalDeadline,
  now,
  fetchFn,
  parentSignal,
}: {
  apiKey: string;
  step: ModelStep;
  mode: PromptMode;
  imageDataUrl: string;
  timeoutMs: number;
  totalDeadline: number;
  now: () => number;
  fetchFn: typeof fetch;
  parentSignal?: AbortSignal;
}): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      return { ok: false, reason: 'client_aborted', timedOutTotal: false };
    }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  try {
    const prompt = PROMPTS[mode];
    const response = await fetchFn(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'AllHail',
      },
      body: JSON.stringify({
        model: step.model,
        max_tokens: 1500,
        temperature: 0.2,
        ...(step.reasoning ? { reasoning: step.reasoning } : {}),
        provider: { data_collection: 'deny' },
        messages: [
          { role: 'system', content: prompt.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt.user },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    const data = (await response.json().catch(() => null)) as OpenRouterResponse | null;
    if (!response.ok || !data || data.error) {
      return {
        ok: false,
        reason: `provider_error_${response.status}`,
        timedOutTotal: now() >= totalDeadline,
      };
    }

    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    const text = extractText(choice?.message?.content);

    if (!text) {
      return { ok: false, reason: 'empty_answer', timedOutTotal: now() >= totalDeadline };
    }
    if (finishReason === 'length') {
      return { ok: false, reason: 'truncated_length', timedOutTotal: now() >= totalDeadline };
    }
    if (isRefusalText(text)) {
      return { ok: false, reason: 'refusal', timedOutTotal: now() >= totalDeadline };
    }

    return { ok: true, text, model: step.model };
  } catch {
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'network_error',
      timedOutTotal: now() >= totalDeadline,
    };
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

export function createDescribeHandler(deps: DescribeDeps = {}) {
  const getApiKey = deps.getApiKey ?? (() => process.env.OPENROUTER_API_KEY?.trim());
  const fetchFn = deps.fetchFn ?? fetch;
  const chains = deps.chains ?? VISION_MODEL_CHAINS;
  const perModelTimeoutMs = deps.perModelTimeoutMs ?? PER_MODEL_TIMEOUT_MS;
  const totalTimeoutMs = deps.totalTimeoutMs ?? TOTAL_REQUEST_TIMEOUT_MS;
  const maxImageBytes = deps.maxImageBytes ?? MAX_IMAGE_BYTES;
  const now = deps.now ?? (() => Date.now());
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({
      maxRequests: RATE_LIMIT_MAX_REQUESTS,
      windowMs: RATE_LIMIT_WINDOW_MS,
      now,
    });

  return async function handleDescribe(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');

    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const limit = rateLimiter.check(clientIp);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: 'rate_limited',
        message: strings.errRateLimited,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const body = req.body as { mode?: unknown; imageDataUrl?: unknown } | undefined;
    const mode = body?.mode;
    const imageDataUrl = body?.imageDataUrl;

    if ((mode !== 'describe' && mode !== 'detail') || typeof imageDataUrl !== 'string') {
      return res.status(400).json({ error: 'invalid_request', message: strings.errInvalidRequest });
    }

    const decodedBytes = decodeImageByteLength(imageDataUrl);
    if (decodedBytes === null || decodedBytes <= 0) {
      return res.status(400).json({ error: 'invalid_image', message: strings.errInvalidRequest });
    }
    if (decodedBytes > maxImageBytes) {
      return res.status(413).json({ error: 'image_too_large', message: strings.errImageTooLarge });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: 'not_configured', message: strings.errDescribeUnavailable });
    }

    const clientAbort = new AbortController();
    const onResponseClose = () => {
      if (!res.writableEnded) {
        clientAbort.abort();
      }
    };
    res.on('close', onResponseClose);

    try {
      const deadline = now() + totalTimeoutMs;
      const steps = chains[mode];
      let sawTotalTimeout = false;

      for (const step of steps) {
        if (clientAbort.signal.aborted) {
          return;
        }
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
          sawTotalTimeout = true;
          break;
        }

        const attemptTimeoutMs = Math.min(perModelTimeoutMs, remainingMs);
        const outcome = await callSingleModel({
          apiKey,
          step,
          mode,
          imageDataUrl,
          timeoutMs: attemptTimeoutMs,
          totalDeadline: deadline,
          now,
          fetchFn,
          parentSignal: clientAbort.signal,
        });

        if (outcome.ok) {
          return res.status(200).json({
            text: outcome.text,
            model: outcome.model,
            mode,
          });
        }
        if (outcome.timedOutTotal) {
          sawTotalTimeout = true;
          break;
        }
      }

      if (clientAbort.signal.aborted) {
        return;
      }

      if (sawTotalTimeout || now() >= deadline) {
        return res.status(504).json({
          error: 'describe_timeout',
          message: strings.errDescribeTimeout,
        });
      }

      return res.status(502).json({
        error: 'describe_failed',
        message: strings.errDescribeFailed,
      });
    } finally {
      res.off('close', onResponseClose);
    }
  };
}
