// Turns a checked report into what the shared reports relay expects: a public GitHub issue and a
// private email. The relay is OverBoard's Google Apps Script (BPMData/OverBoard, tools/report-relay.gs),
// shared by OverBoard, AllAboard, AllHail and OverHeard. It does no per-app formatting, so it all
// happens here. The issue is built ONLY from the public part; the person's own words and email
// go only into the email. Runs with Node type stripping: no enums here.
import { REPORT_APP, REPORT_KIND, type ProblemReport } from '../shared/report.ts';

export const ISSUE_LABEL = 'problem-report';

/** Category names as they appear in issues and emails (English, for the maintainers). */
const CATEGORY_NAMES: Record<string, string> = {
  camera: 'Taking or choosing a photo',
  descriptions: 'Photo descriptions',
  speech: 'Speech, voices or MP3',
  offline: 'Offline use, installing or updating',
  history: 'Saved history',
  access: 'Screen reader, keyboard or text size',
  other: 'Something else',
};

export type RelayMessage = {
  app: typeof REPORT_APP;
  kind: typeof REPORT_KIND;
  token: string;
  issue: { title: string; body: string; labels: string[] };
  email: { subject: string; body: string; replyTo?: string };
};

/** Anything going into the public issue is kept plain: no links, @mentions, HTML or markdown tricks. */
function clean(value: unknown, max = 160): string {
  return String(value ?? '')
    .replace(/[<>@`*_[\]|#\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function category(report: ProblemReport): string {
  return CATEGORY_NAMES[report.public.category] ?? 'Something else';
}

function system(report: ProblemReport): string {
  const d = report.public.diagnostics;
  return `${clean(d.os || 'unknown system', 60)} · ${clean(d.browser || 'unknown browser', 60)}`;
}

/** The public summary: category, ticks, version, system and the safe diagnostics. */
function summary(report: ProblemReport): string {
  const p = report.public;
  const d = p.diagnostics as Record<string, string | number | boolean | undefined>;
  const lines = [
    `**What went wrong:** ${category(report)}`,
    `**What fits:** ${p.symptoms.map((s) => clean(s, 40)).join(', ') || 'nothing ticked'}`,
    `**AllHail:** ${clean(d.appVersion || '?', 20)} (built ${clean(d.appBuilt || '?', 20)})`,
    `**System:** ${system(report)} · ${clean(d.deviceClass || '?', 20)}`,
    '',
    '| Detail | Value |',
    '|---|---|',
  ];
  for (const key of Object.keys(d)) {
    if (key === 'userAgent') continue;
    lines.push(`| ${clean(key, 40)} | ${clean(d[key], 160)} |`);
  }
  if (d.userAgent) lines.push('', `Browser details: ${clean(d.userAgent, 400)}`);
  return lines.join('\n');
}

export function buildRelayMessage(report: ProblemReport, token: string): RelayMessage {
  const title = `Problem report: ${category(report)} · ${system(report)}`.slice(0, 200);
  const issueBody =
    summary(report) +
    '\n\n<sub>Sent from AllHail\'s "Something not working?" page. The person\'s own words and email, if any, went to the private reports inbox only.</sub>';

  const priv = report.private;
  const replyTo = priv.email.trim();
  const emailBody = [
    `Their email: ${replyTo || '(none given)'}`,
    `What happened: ${priv.details ? `\n${priv.details}` : '(not given)'}`,
    `How to make it happen again: ${priv.steps ? `\n${priv.steps}` : '(not given)'}`,
    '',
    summary(report).replace(/\*\*/g, ''),
    '',
    'The full report:',
    JSON.stringify({ app: report.app, kind: report.kind, public: report.public, private: report.private }, null, 1),
  ].join('\n');

  return {
    app: REPORT_APP,
    kind: REPORT_KIND,
    token,
    issue: { title, body: issueBody, labels: [ISSUE_LABEL] },
    email: {
      subject: `[${REPORT_APP}] Problem report: ${category(report)} · ${system(report)}`,
      body: emailBody,
      ...(replyTo ? { replyTo } : {}),
    },
  };
}
