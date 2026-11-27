import type { Request, Response } from 'express';
import { sanitizeReport } from '../shared/report.ts';
import { strings } from '../shared/strings.ts';
import { createRateLimiter, type RateLimiter } from './rateLimit.ts';

/**
 * POST /api/report: checks a "Something not working?" report and passes it to the reports relay
 * (tools/report-relay.gs, a Google Apps Script under the shared reports Gmail account). The relay
 * opens the public GitHub issue and emails the full report. The GitHub token lives only in the
 * relay; this server only knows the relay's address and a shared secret, both from env vars.
 * The private part of a report (comments, email) is never logged here.
 */

export const REPORT_RATE_LIMIT_MAX = 5;
export const REPORT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const REPORT_RELAY_TIMEOUT_MS = 25_000;
export const MAX_REPORT_BODY = '64kb';

// Only ever hand the browser a link to an issue in this app's own repository.
const ISSUE_URL_RE = /^https:\/\/github\.com\/bpmdata\/allhail\/issues\/\d+$/i;

export type ReportDeps = {
  getRelayUrl?: () => string | undefined;
  getRelaySecret?: () => string | undefined;
  fetchFn?: typeof fetch;
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
};

type RelayReply = { ok?: boolean; error?: string; issue?: unknown; url?: unknown };

export function createReportHandler(deps: ReportDeps = {}) {
  const getRelayUrl = deps.getRelayUrl ?? (() => process.env.REPORT_RELAY_URL);
  const getRelaySecret = deps.getRelaySecret ?? (() => process.env.REPORT_RELAY_SECRET);
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REPORT_RELAY_TIMEOUT_MS;
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({
      maxRequests: REPORT_RATE_LIMIT_MAX,
      windowMs: REPORT_RATE_LIMIT_WINDOW_MS,
    });

  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const report = sanitizeReport(req.body);
    if (!report) {
      return res.status(400).json({ error: 'invalid_report', message: strings.errReportInvalid });
    }
    // The hidden box was filled in: a robot. Pretend it worked so it doesn't try again.
    if (report.website) return res.json({ ok: true, issueUrl: null });

    const limit = rateLimiter.check(req.ip || 'unknown');
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', message: strings.errRateLimited });
    }

    const relayUrl = getRelayUrl()?.trim();
    const secret = getRelaySecret()?.trim();
    if (!relayUrl || !secret || !/^https:\/\//.test(relayUrl)) {
      return res.status(503).json({ error: 'reports_unavailable', message: strings.errReportUnavailable });
    }

    const { website: _website, ...forward } = report;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Apps Script answers a POST with a redirect to the result; fetch follows it.
      const response = await fetchFn(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...forward, secret }),
        redirect: 'follow',
        signal: controller.signal,
      });
      let reply: RelayReply = {};
      try {
        reply = (await response.json()) as RelayReply;
      } catch {
        reply = {};
      }
      if (!response.ok || reply.ok !== true) {
        console.warn(`Report relay refused a report: ${response.status} ${String(reply.error ?? '').slice(0, 100)}`);
        return res.status(502).json({ error: 'report_failed', message: strings.errReportFailed });
      }
      const issueUrl = typeof reply.url === 'string' && ISSUE_URL_RE.test(reply.url) ? reply.url : null;
      return res.json({ ok: true, issueUrl });
    } catch (error) {
      console.warn(`Report relay could not be reached: ${error instanceof Error ? error.name : 'error'}`);
      return res.status(502).json({ error: 'report_failed', message: strings.errReportFailed });
    } finally {
      clearTimeout(timer);
    }
  };
}
