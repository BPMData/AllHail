// @vitest-environment node
// Runs the real tools/report-relay.gs (the Google Apps Script relay) against fake Google services,
// so the delivery path is checked in CI: the right repo and label, public vs private, and the limits.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../tools/report-relay.gs', import.meta.url), 'utf8');

type Fetched = { url: string; options: { payload?: string; headers?: Record<string, string> } };
type Mail = Record<string, unknown>;

function loadRelay({ githubStatus = 201, secret = 'relay-secret' } = {}) {
  const props = new Map<string, string>(
    Object.entries({ GITHUB_TOKEN: 'github_pat_test', GITHUB_REPO: 'BPMData/allhail', RELAY_SECRET: secret })
  );
  const cache = new Map<string, string>();
  const fetched: Fetched[] = [];
  const mail: Mail[] = [];
  const context: Record<string, unknown> = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => props.get(key) ?? null,
        setProperty: (key: string, value: string) => void props.set(key, value),
        deleteProperty: (key: string) => void props.delete(key),
        getProperties: () => Object.fromEntries(props),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache.get(k) ?? null,
        put: (k: string, v: string) => void cache.set(k, v),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text: string) => ({
        text,
        setMimeType() {
          return this;
        },
      }),
    },
    UrlFetchApp: {
      fetch: (url: string, options: Fetched['options']) => {
        fetched.push({ url, options });
        return {
          getResponseCode: () => githubStatus,
          getContentText: () =>
            JSON.stringify({ number: 42, html_url: 'https://github.com/BPMData/allhail/issues/42' }),
        };
      },
    },
    MailApp: {
      sendEmail: (opts: Mail | string, subject?: string, body?: string) =>
        void mail.push(typeof opts === 'string' ? { to: opts, subject, body } : opts),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'overboard.reporting@gmail.com' }) },
    Utilities: {
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_alg: string, text: string) => [...createHash('sha256').update(text).digest()],
      newBlob: (data: string, type: string, name: string) => ({ data, type, name }),
    },
    Logger: { log: () => undefined },
  };
  runInNewContext(source, context);
  const post = (body: unknown) => {
    const out = (context.doPost as (e: unknown) => { text: string })({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.text) as Record<string, unknown>;
  };
  return { post, fetched, mail, props };
}

const report = {
  app: 'AllHail',
  kind: 'problem-report',
  secret: 'relay-secret',
  public: {
    category: 'descriptions',
    symptoms: ['no-description'],
    diagnostics: {
      appVersion: '0.1.0',
      appBuilt: '2026-11-24',
      os: 'iOS 18.1',
      browser: 'Safari 18',
      deviceClass: 'phone',
      lastStatus: 'Could not describe photo. <b>@everyone</b>',
    },
  },
  private: {
    details: 'Nothing came back for my student Jamie’s worksheet.',
    steps: 'Full detail, then Take photo',
    email: 'teacher@example.org',
  },
};

describe('report relay (tools/report-relay.gs)', () => {
  it('opens a labeled issue in AllHail’s repo from the public part only', () => {
    const relay = loadRelay();
    const reply = relay.post(report);
    expect(reply).toMatchObject({
      ok: true,
      issue: 42,
      url: 'https://github.com/BPMData/allhail/issues/42',
      thanked: true,
    });

    const issueCall = relay.fetched.find((call) => call.url.endsWith('/issues'));
    expect(issueCall?.url).toBe('https://api.github.com/repos/BPMData/allhail/issues');
    const issue = JSON.parse(String(issueCall?.options.payload));
    expect(issue.labels).toEqual(['problem-report']);
    expect(issue.title).toBe('Problem report: Photo descriptions · iOS 18.1 · Safari 18');
    const publicText = JSON.stringify(issue);
    expect(publicText).not.toContain('Jamie');
    expect(publicText).not.toContain('Full detail, then');
    expect(publicText).not.toContain('teacher@example.org');
    expect(publicText).not.toContain('relay-secret');
    // Typed-looking content is defanged before it reaches the public issue.
    expect(issue.body).not.toMatch(/<b>|@everyone/);
  });

  it('emails the full report, with the person’s words, to the shared inbox', () => {
    const relay = loadRelay();
    relay.post(report);
    const inbox = relay.mail.find((m) => m.to === 'overboard.reporting@gmail.com');
    expect(inbox?.subject).toBe('AllHail problem report: Photo descriptions · iOS 18.1 · Safari 18');
    expect(String(inbox?.body)).toContain('Jamie');
    expect(String(inbox?.body)).toContain('https://github.com/BPMData/allhail/issues/42');
    expect(inbox?.replyTo).toBe('teacher@example.org');
    expect(JSON.stringify(inbox)).not.toContain('relay-secret');
    const thanks = relay.mail.find((m) => m.to === 'teacher@example.org');
    expect(thanks?.subject).toBe('We got your AllHail report');
  });

  it('still emails the report when GitHub fails', () => {
    const relay = loadRelay({ githubStatus: 401 });
    const reply = relay.post(report);
    expect(reply).toMatchObject({ ok: true, issue: null, url: null });
    const inbox = relay.mail.find((m) => m.to === 'overboard.reporting@gmail.com');
    expect(String(inbox?.body)).toContain('The GitHub issue could not be made');
  });

  it('refuses posts without the shared secret, or that are not AllHail reports', () => {
    const relay = loadRelay();
    expect(relay.post({ ...report, secret: 'wrong' })).toMatchObject({ ok: false, error: 'not allowed' });
    expect(relay.post({ ...report, app: 'OverBoard' })).toMatchObject({ ok: false, error: 'not a report' });
    expect(relay.fetched).toHaveLength(0);
    expect(relay.mail).toHaveLength(0);
    expect(loadRelay({ secret: '' }).post(report)).toMatchObject({ ok: false });
  });

  it('thanks an address at most once a week and stops after the hourly limit', () => {
    const relay = loadRelay();
    relay.post(report);
    relay.post(report);
    expect(relay.mail.filter((m) => m.to === 'teacher@example.org')).toHaveLength(1);
    for (let i = 0; i < 18; i += 1) relay.post({ ...report, private: { details: '', steps: '', email: '' } });
    expect(relay.post(report)).toMatchObject({ ok: false, error: 'busy' });
  });
});
