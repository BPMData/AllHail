// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildReport } from '../shared/report.ts';
import { buildRelayMessage } from './reportMessage.ts';

function report(overrides: { details?: string; steps?: string; email?: string } = {}) {
  const built = buildReport({
    category: 'camera',
    symptoms: ['camera-wont-open'],
    details: overrides.details ?? 'Secret words from <b>@someone</b>',
    steps: overrides.steps ?? 'Opened camera',
    email: overrides.email ?? 'person@example.org',
    diagnostics: { appVersion: '0.2.0', os: 'iOS 19', browser: 'Safari 19', userAgent: 'Mozilla/5.0 <script>' },
  });
  if (!built) throw new Error('test report did not build');
  return built;
}

describe('buildRelayMessage', () => {
  it('builds the issue from the public part only', () => {
    const message = buildRelayMessage(report(), 'tok');
    const issue = JSON.stringify(message.issue);
    expect(issue).not.toContain('Secret words');
    expect(issue).not.toContain('Opened camera');
    expect(issue).not.toContain('person@example.org');
    expect(message.issue.body).toContain('**What went wrong:** Taking or choosing a photo');
    expect(message.issue.body).toContain('camera-wont-open');
    expect(message.issue.body).toContain('**AllHail:** 0.2.0');
  });

  it('keeps markdown, HTML and mentions out of the public issue', () => {
    const message = buildRelayMessage(report(), 'tok');
    expect(message.issue.body).not.toContain('<script>');
    expect(message.issue.body).toContain('Browser details: Mozilla/5.0 script');
  });

  it('puts the whole report in the private email, answerable with Reply', () => {
    const message = buildRelayMessage(report(), 'tok');
    expect(message.email.subject.startsWith('[AllHail] Problem report: Taking or choosing a photo')).toBe(true);
    expect(message.email.body).toContain('Secret words from <b>@someone</b>');
    expect(message.email.body).toContain('Opened camera');
    expect(message.email.body).toContain('"email": "person@example.org"');
    expect(message.email.replyTo).toBe('person@example.org');
    expect(message.token).toBe('tok');
  });

  it('leaves replyTo out when no email was given', () => {
    const message = buildRelayMessage(report({ email: '' }), 'tok');
    expect(message.email).not.toHaveProperty('replyTo');
    expect(message.email.body).toContain('Their email: (none given)');
  });
});
