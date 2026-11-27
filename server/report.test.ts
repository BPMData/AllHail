// @vitest-environment node
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rateLimit.ts';
import { createReportHandler, type ReportDeps } from './report.ts';

const goodReport = {
  app: 'AllHail',
  kind: 'problem-report',
  public: {
    category: 'speech',
    symptoms: ['nothing-read', 'not-a-real-symptom'],
    diagnostics: {
      appVersion: '0.1.0',
      os: 'Android 15',
      browser: 'Chrome 131',
      photoData: 'data:image/jpeg;base64,AAAA',
      speaking: false,
    },
  },
  private: {
    details: "It went quiet after the photo of Ms. Rivera's worksheet.",
    steps: '',
    email: 'teacher@example.org',
  },
  website: '',
};

let servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
});

async function start(reportDeps: ReportDeps) {
  const app = express();
  app.post('/api/report', express.json({ limit: '64kb' }), createReportHandler(reportDeps));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (body: unknown) =>
    fetch(`${base}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
}

function relayReturning(reply: unknown, status = 200) {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

const configured = (fetchFn: typeof fetch): ReportDeps => ({
  getRelayUrl: () => 'https://script.google.com/macros/s/test/exec',
  getRelaySecret: () => 'shh',
  fetchFn,
  rateLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
});

describe('POST /api/report', () => {
  it('cleans the report and passes it to the relay with the secret', async () => {
    const fetchFn = relayReturning({ ok: true, issue: 12, url: 'https://github.com/BPMData/allhail/issues/12' });
    const post = await start(configured(fetchFn));
    const response = await post(goodReport);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, issueUrl: 'https://github.com/BPMData/allhail/issues/12' });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://script.google.com/macros/s/test/exec');
    const sent = JSON.parse(String(init?.body));
    expect(sent.secret).toBe('shh');
    expect(sent.public.symptoms).toEqual(['nothing-read']);
    expect(sent.public.diagnostics).toEqual({
      appVersion: '0.1.0',
      os: 'Android 15',
      browser: 'Chrome 131',
      speaking: false,
    });
    expect(sent.private.email).toBe('teacher@example.org');
    expect(sent).not.toHaveProperty('website');
  });

  it('never hands the browser a link outside this repository', async () => {
    const post = await start(configured(relayReturning({ ok: true, url: 'https://evil.example/issues/1' })));
    expect(await (await post(goodReport)).json()).toEqual({ ok: true, issueUrl: null });
  });

  it('rejects things that are not AllHail reports', async () => {
    const fetchFn = relayReturning({ ok: true });
    const post = await start(configured(fetchFn));
    expect((await post({ ...goodReport, app: 'OverBoard' })).status).toBe(400);
    expect((await post({ ...goodReport, public: { ...goodReport.public, category: 'nope' } })).status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('quietly drops reports with the hidden robot box filled in', async () => {
    const fetchFn = relayReturning({ ok: true });
    const post = await start(configured(fetchFn));
    const response = await post({ ...goodReport, website: 'http://spam.example' });
    expect(response.status).toBe(200);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says so when the relay is not set up, so the page offers the email fallback', async () => {
    const post = await start({ getRelayUrl: () => undefined, getRelaySecret: () => undefined });
    const response = await post(goodReport);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('reports_unavailable');
  });

  it('reports a failure when the relay refuses or cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = await start(configured(relayReturning({ ok: false, error: 'busy' })));
    expect((await refused(goodReport)).status).toBe(502);
    const down = await start(
      configured(
        vi.fn<typeof fetch>(async () => {
          throw new TypeError('network down');
        })
      )
    );
    expect((await down(goodReport)).status).toBe(502);
    // Logs never include what the person wrote.
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toContain('Rivera');
    expect(logged).not.toContain('teacher@example.org');
  });

  it('limits how many reports one address can send', async () => {
    const post = await start({
      ...configured(relayReturning({ ok: true })),
      rateLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    expect((await post(goodReport)).status).toBe(200);
    const second = await post(goodReport);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });
});
