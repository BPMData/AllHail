import express from 'express';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMPTS } from '../shared/prompts.ts';
import { createDescribeHandler, type DescribeDeps } from './describe.ts';
import { createRateLimiter } from './rateLimit.ts';
import { VISION_MODEL_CHAINS } from './visionConfig.ts';

const TINY_JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

async function withServer(
  describeDeps: DescribeDeps,
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.post('/api/describe', express.json({ limit: '6mb' }), createDescribeHandler(describeDeps));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/describe', () => {
  it('sends v5 prompt, data_collection deny, and thinking-off config for Quick look', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'A sunny classroom whiteboard.' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await withServer({ getApiKey: () => 'test-key', fetchFn }, async (base) => {
      const res = await fetch(`${base}/api/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'describe', imageDataUrl: TINY_JPEG_DATA_URL }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { text: string; model: string; mode: string };
      expect(data.text).toBe('A sunny classroom whiteboard.');
      expect(data.model).toBe(VISION_MODEL_CHAINS.describe[0].model);
      expect(data.mode).toBe('describe');
      expect(calls).toHaveLength(1);
      expect(calls[0].body.provider).toEqual({ data_collection: 'deny' });
      expect(calls[0].body.reasoning).toEqual({ enabled: false });
      expect(calls[0].body.messages[0].content).toBe(PROMPTS.describe.system);
      expect(calls[0].body.messages[1].content[0].text).toBe(PROMPTS.describe.user);
    });
  });

  it('falls back through the chain on error, length cutoff, blank answer, and refusal', async () => {
    const modelsTried: string[] = [];
    let attempt = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      modelsTried.push(body.model);
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status: 502 });
      }
      if (attempt === 2) {
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Partial...' } }] }),
          { status: 200 },
        );
      }
      if (attempt === 3) {
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: "I can't help with that." } }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Complete detailed reading.' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await withServer({ getApiKey: () => 'test-key', fetchFn }, async (base) => {
      const res = await fetch(`${base}/api/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'detail', imageDataUrl: TINY_JPEG_DATA_URL }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { text: string; model: string };
      expect(data.text).toBe('Complete detailed reading.');
      expect(modelsTried).toEqual(VISION_MODEL_CHAINS.detail.map((s) => s.model));
    });
  });

  it('moves to the next model when an attempt exceeds its per-model timeout', async () => {
    const modelsTried: string[] = [];
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      modelsTried.push(body.model);
      if (modelsTried.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Fallback succeeded.' } }] }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    await withServer(
      { getApiKey: () => 'test-key', fetchFn, perModelTimeoutMs: 25, totalTimeoutMs: 2000 },
      async (base) => {
        const res = await fetch(`${base}/api/describe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'describe', imageDataUrl: TINY_JPEG_DATA_URL }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { text: string; model: string };
        expect(data.text).toBe('Fallback succeeded.');
        expect(modelsTried).toHaveLength(2);
      },
    );
  });

  it('returns 504 when the overall request timeout budget expires', async () => {
    let clock = 0;
    const fetchFn = vi.fn(async () => {
      clock += 60_000;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await withServer(
      { getApiKey: () => 'test-key', fetchFn, totalTimeoutMs: 90_000, now: () => clock },
      async (base) => {
        const res = await fetch(`${base}/api/describe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'detail', imageDataUrl: TINY_JPEG_DATA_URL }),
        });
        expect(res.status).toBe(504);
      },
    );
  });

  it('rejects decoded images larger than 4 MB with HTTP 413', async () => {
    const oversizedBytes = Buffer.alloc(4 * 1024 * 1024 + 64, 1);
    const oversizedUrl = `data:image/jpeg;base64,${oversizedBytes.toString('base64')}`;
    const fetchFn = vi.fn() as unknown as typeof fetch;

    await withServer({ getApiKey: () => 'test-key', fetchFn }, async (base) => {
      const res = await fetch(`${base}/api/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'describe', imageDataUrl: oversizedUrl }),
      });
      expect(res.status).toBe(413);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it('enforces per-IP rate limiting and returns 429', async () => {
    const rateLimiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Ok.' } }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await withServer({ getApiKey: () => 'test-key', fetchFn, rateLimiter }, async (base) => {
      const send = () =>
        fetch(`${base}/api/describe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'describe', imageDataUrl: TINY_JPEG_DATA_URL }),
        });

      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      const blocked = await send();
      expect(blocked.status).toBe(429);
      const data = (await blocked.json()) as { error: string };
      expect(data.error).toBe('rate_limited');
    });
  });
});
