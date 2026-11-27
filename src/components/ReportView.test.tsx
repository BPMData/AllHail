import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORT_INBOX, type ProblemReport } from '../../shared/report.ts';
import { strings } from '../../shared/strings.ts';
import { ReportView, sendReportToServer, type SendReportResult } from './ReportView.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const diagnostics = { appVersion: '0.1.0', os: 'Android 15', browser: 'Chrome 131', online: true, speaking: false };

function setup({
  online = true,
  result = { ok: true, issueUrl: 'https://github.com/BPMData/allhail/issues/7' } as SendReportResult,
} = {}) {
  const sendReport = vi.fn(async (_report: ProblemReport) => result);
  const onClose = vi.fn();
  render(
    <ReportView online={online} getDiagnostics={async () => diagnostics} onClose={onClose} sendReport={sendReport} />
  );
  return { sendReport, onClose };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: strings.reportNext }));

async function walkToReview({ details = '', email = '' } = {}) {
  fireEvent.click(screen.getByRole('radio', { name: strings.reportCatSpeech }));
  next();
  fireEvent.click(screen.getByRole('checkbox', { name: strings.reportSymNothingRead }));
  if (details) fireEvent.change(screen.getByLabelText(strings.reportDetailsLabel), { target: { value: details } });
  next();
  if (email) fireEvent.change(screen.getByLabelText(strings.reportEmailLabel), { target: { value: email } });
  next();
  await screen.findByRole('heading', { name: new RegExp(strings.reportStepReview) });
}

describe('guided problem report', () => {
  it('walks through short numbered steps, moving focus to each step heading', async () => {
    setup();
    const first = screen.getByRole('heading', { level: 2, name: /Step 1 of 4.*What went wrong/ });
    expect(document.activeElement).toBe(first);

    // Next without a choice explains what to do instead of silently doing nothing.
    next();
    expect(screen.getByRole('alert').textContent).toContain(strings.reportChooseCategoryError);

    fireEvent.click(screen.getByRole('radio', { name: strings.reportCatCamera }));
    next();
    const second = screen.getByRole('heading', { level: 2, name: /Step 2 of 4.*What happened/ });
    expect(document.activeElement).toBe(second);
    // Everything on this step is optional: skipping straight on works.
    next();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: /Step 3 of 4/ }));
    fireEvent.click(screen.getByRole('button', { name: strings.reportBack }));
    expect(screen.getByRole('heading', { level: 2, name: /Step 2 of 4/ })).toBeTruthy();
  });

  it('shows exactly what is public and what is private, and sends nothing before Send', async () => {
    const { sendReport } = setup();
    await walkToReview({ details: 'It stopped after one sentence.', email: 'me@example.org' });

    const publicPart = screen.getByRole('region', { name: strings.reportPublicHeading });
    expect(publicPart.textContent).toContain(strings.reportCatSpeech);
    expect(publicPart.textContent).toContain(strings.reportSymNothingRead);
    expect(publicPart.textContent).toContain('Android 15');
    expect(publicPart.textContent).not.toContain('It stopped after one sentence.');
    expect(publicPart.textContent).not.toContain('me@example.org');

    const privatePart = screen.getByRole('region', { name: strings.reportPrivateHeading });
    expect(privatePart.textContent).toContain('It stopped after one sentence.');
    expect(privatePart.textContent).toContain('me@example.org');

    expect(sendReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: strings.reportSend }));
    await screen.findByRole('heading', { name: strings.reportSentHeading });

    expect(sendReport).toHaveBeenCalledOnce();
    const sent = sendReport.mock.calls[0][0];
    expect(sent.public).toEqual({ category: 'speech', symptoms: ['nothing-read'], diagnostics });
    expect(sent.private).toEqual({ details: 'It stopped after one sentence.', steps: '', email: 'me@example.org' });
    expect(screen.getByRole('link', { name: strings.reportIssueLink }).getAttribute('href')).toBe(
      'https://github.com/BPMData/allhail/issues/7'
    );
    expect(screen.getByRole('status').textContent).toContain(strings.reportSentHeading);
  });

  it('stops on a bad email address with a clear message', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: strings.reportCatOther }));
    next();
    next();
    fireEvent.change(screen.getByLabelText(strings.reportEmailLabel), { target: { value: 'not an email' } });
    next();
    expect(screen.getByRole('alert').textContent).toContain(strings.reportEmailInvalid);
    expect(screen.getByLabelText(strings.reportEmailLabel).getAttribute('aria-invalid')).toBe('true');
  });

  it('offers copy, download and email to the shared inbox when sending fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup({ result: { ok: false, message: strings.errReportUnavailable } });
    await walkToReview({ details: 'Private words' });
    fireEvent.click(screen.getByRole('button', { name: strings.reportSend }));

    await screen.findByRole('heading', { name: strings.reportFailedHeading });
    expect(screen.getByText(strings.errReportUnavailable)).toBeTruthy();
    expect(screen.getByText(new RegExp(REPORT_INBOX))).toBeTruthy();

    const mailto = screen.getByRole('link', { name: strings.reportEmailIt }).getAttribute('href') ?? '';
    expect(mailto.startsWith(`mailto:${REPORT_INBOX}?subject=`)).toBe(true);
    expect(decodeURIComponent(mailto)).toContain('AllHail problem report');

    fireEvent.click(screen.getByRole('button', { name: strings.reportCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('Private words');
    expect(screen.getByRole('status').textContent).toContain(strings.reportCopied);
    expect(screen.getByRole('button', { name: strings.reportTryAgain })).toBeTruthy();
  });

  it('goes straight to the offline fallback without trying to send', async () => {
    const { sendReport } = setup({ online: false });
    await walkToReview();
    fireEvent.click(screen.getByRole('button', { name: strings.reportSend }));
    expect(screen.getByRole('heading', { name: strings.reportOfflineHeading })).toBeTruthy();
    expect(sendReport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: strings.reportDownload })).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.reportTryAgain })).toBeNull();
  });

  it('Cancel leaves the report without sending', () => {
    const { onClose, sendReport } = setup();
    fireEvent.click(screen.getByRole('button', { name: strings.reportCancel }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(sendReport).not.toHaveBeenCalled();
  });
});

describe('sendReportToServer', () => {
  const report = {
    app: 'AllHail',
    kind: 'problem-report',
    public: { category: 'other', symptoms: [], diagnostics: {} },
    private: { details: '', steps: '', email: '' },
  } as ProblemReport;

  it('posts to /api/report and returns the issue link', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, issueUrl: 'https://github.com/BPMData/allhail/issues/3' })
    );
    expect(await sendReportToServer(report, fetchFn)).toEqual({
      ok: true,
      issueUrl: 'https://github.com/BPMData/allhail/issues/3',
    });
    expect(fetchFn.mock.calls[0][0]).toBe('/api/report');
  });

  it('turns server errors and network failures into a message', async () => {
    const unavailable = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'reports_unavailable', message: 'nope' }, { status: 503 })
    );
    expect(await sendReportToServer(report, unavailable)).toEqual({ ok: false, message: 'nope' });
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });
    expect(await sendReportToServer(report, down)).toEqual({ ok: false, message: strings.errReportFailed });
  });
});
