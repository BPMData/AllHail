import { useEffect, useId, useRef, useState } from 'react';
import {
  buildReport,
  categoryLabel,
  DIAGNOSTIC_LABELS,
  EMAIL_RE,
  formatDiagnosticValue,
  formatReportText,
  REPORT_CATEGORIES,
  REPORT_INBOX,
  reportMailtoHref,
  symptomLabels,
  type DiagnosticKey,
  type Diagnostics,
  type ProblemReport,
} from '../../shared/report.ts';
import { strings } from '../../shared/strings.ts';

type Step = 'category' | 'details' | 'contact' | 'review' | 'sending' | 'sent' | 'fallback';
const NUMBERED_STEPS: readonly Step[] = ['category', 'details', 'contact', 'review'];

export type SendReportResult = { ok: true; issueUrl: string | null } | { ok: false; message: string };

export async function sendReportToServer(report: ProblemReport, fetchFn: typeof fetch = fetch): Promise<SendReportResult> {
  try {
    const response = await fetchFn('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; issueUrl?: unknown; message?: unknown };
    if (response.ok && data.ok === true) {
      return { ok: true, issueUrl: typeof data.issueUrl === 'string' ? data.issueUrl : null };
    }
    return { ok: false, message: typeof data.message === 'string' ? data.message : strings.errReportFailed };
  } catch {
    return { ok: false, message: strings.errReportFailed };
  }
}

type ReportViewProps = {
  online: boolean;
  /** Called when the review step opens, so the diagnostics are fresh. */
  getDiagnostics: () => Promise<Diagnostics>;
  onClose: () => void;
  sendReport?: (report: ProblemReport) => Promise<SendReportResult>;
};

export function ReportView({ online, getDiagnostics, onClose, sendReport = (report) => sendReportToServer(report) }: ReportViewProps) {
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>('category');
  const [category, setCategory] = useState('');
  const [categoryError, setCategoryError] = useState(false);
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [details, setDetails] = useState('');
  const [steps, setSteps] = useState('');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const [website, setWebsite] = useState('');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<'offline' | 'failed'>('failed');
  const [failureMessage, setFailureMessage] = useState('');
  const [announcement, setAnnouncement] = useState('');

  // Move focus to each new step's heading, so screen readers start reading there.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const selectedCategory = REPORT_CATEGORIES.find((item) => item.id === category);
  const report: ProblemReport | null = diagnostics
    ? buildReport({ category, symptoms, details, steps, email, diagnostics, website })
    : null;

  const stepNumber = NUMBERED_STEPS.indexOf(step) + 1;
  const stepLabel = stepNumber > 0
    ? strings.reportStepTemplate.replace('{n}', String(stepNumber)).replace('{total}', String(NUMBERED_STEPS.length))
    : '';

  const goToReview = async () => {
    setDiagnostics(await getDiagnostics());
    setStep('review');
  };

  const handleSend = async () => {
    if (!report) return;
    if (!online) {
      setFailure('offline');
      setFailureMessage('');
      setStep('fallback');
      return;
    }
    setStep('sending');
    setAnnouncement(strings.reportSending);
    const result = await sendReport(report);
    if (result.ok) {
      setIssueUrl(result.issueUrl);
      setAnnouncement(strings.reportSentHeading);
      setStep('sent');
    } else {
      setFailure('failed');
      setFailureMessage(result.message);
      setAnnouncement(strings.reportFailedHeading);
      setStep('fallback');
    }
  };

  const handleCopy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatReportText(report));
      setAnnouncement(strings.reportCopied);
    } catch {
      setAnnouncement(strings.reportCopyFailed);
    }
  };

  const handleDownload = () => {
    if (!report) return;
    const blob = new Blob([formatReportText(report)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `AllHail-problem-report-${new Date().toISOString().slice(0, 10)}.txt`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setAnnouncement(strings.reportDownloaded);
  };

  const primary = 'primary-cta min-h-[56px] rounded-sm px-6 py-3 text-lg font-bold';
  const secondary = 'surface-button min-h-[56px] rounded-sm border px-6 py-3 text-lg font-bold';
  const choiceRow = 'flex min-h-[56px] cursor-pointer items-center gap-4 rounded-sm border px-4 py-3 text-lg';

  const heading = (text: string) => (
    <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold leading-tight">
      {stepLabel && <span className="block text-base font-bold opacity-85">{stepLabel}<span className="sr-only">: </span></span>}
      {text}
    </h2>
  );

  const navButtons = (onNext: () => void, onBack?: () => void) => (
    <div className="mt-6 flex flex-wrap gap-3">
      <button type="button" className={primary} onClick={onNext}>{strings.reportNext}</button>
      {onBack && <button type="button" className={secondary} onClick={onBack}>{strings.reportBack}</button>}
      <button type="button" className={secondary} onClick={onClose}>{strings.reportCancel}</button>
    </div>
  );

  return (
    <section aria-labelledby={`${ids}-title`} className="panel-card rounded-sm border">
      <div className="panel-header">
        <h1 id={`${ids}-title`} className="text-3xl font-bold leading-tight">{strings.reportHeading}</h1>
        {step === 'category' && <p className="mt-2 text-lg">{strings.reportIntro}</p>}
      </div>

      <div className="panel-body">
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

        {step === 'category' && (
          <form onSubmit={(event) => event.preventDefault()}>
            {heading(strings.reportStepCategory)}
            <fieldset className="mt-4" aria-describedby={categoryError ? `${ids}-cat-error` : `${ids}-cat-hint`}>
              <legend className="sr-only">{strings.reportStepCategory}</legend>
              <p id={`${ids}-cat-hint`} className="mb-3 text-lg">{strings.reportStepCategoryHint}</p>
              {categoryError && (
                <p id={`${ids}-cat-error`} role="alert" className="mb-3 text-lg font-bold">{strings.reportChooseCategoryError}</p>
              )}
              <div className="grid gap-3">
                {REPORT_CATEGORIES.map((item) => (
                  <label key={item.id} className={choiceRow}>
                    <input
                      type="radio"
                      name={`${ids}-category`}
                      value={item.id}
                      checked={category === item.id}
                      onChange={() => {
                        if (item.id !== category) setSymptoms([]);
                        setCategory(item.id);
                        setCategoryError(false);
                      }}
                      className="h-6 w-6 shrink-0 accent-[#6e1d20]"
                    />
                    <span className="font-bold">{item.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {navButtons(() => {
              if (!category) {
                setCategoryError(true);
                return;
              }
              setStep('details');
            })}
          </form>
        )}

        {step === 'details' && (
          <form onSubmit={(event) => event.preventDefault()}>
            {heading(strings.reportStepDetails)}
            {selectedCategory && selectedCategory.symptoms.length > 0 && (
              <fieldset className="mt-4">
                <legend className="mb-3 text-lg font-bold">{strings.reportSymptomsLegend}</legend>
                <div className="grid gap-3">
                  {selectedCategory.symptoms.map((symptom) => (
                    <label key={symptom.id} className={choiceRow}>
                      <input
                        type="checkbox"
                        checked={symptoms.includes(symptom.id)}
                        onChange={(event) =>
                          setSymptoms((current) =>
                            event.target.checked ? [...current, symptom.id] : current.filter((id) => id !== symptom.id),
                          )
                        }
                        className="h-6 w-6 shrink-0 accent-[#6e1d20]"
                      />
                      <span>{symptom.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="mt-5">
              <label htmlFor={`${ids}-details`} className="block text-lg font-bold">{strings.reportDetailsLabel}</label>
              <p id={`${ids}-details-hint`} className="text-base opacity-85">{strings.reportDetailsHint}</p>
              <textarea
                id={`${ids}-details`}
                aria-describedby={`${ids}-details-hint`}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={4}
                maxLength={4000}
                className="reader-surface mt-2 w-full rounded-sm border p-3 text-lg"
              />
            </div>
            <div className="mt-5">
              <label htmlFor={`${ids}-steps`} className="block text-lg font-bold">{strings.reportStepsLabel}</label>
              <p id={`${ids}-steps-hint`} className="text-base opacity-85">{strings.reportStepsHint}</p>
              <textarea
                id={`${ids}-steps`}
                aria-describedby={`${ids}-steps-hint`}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                rows={4}
                maxLength={4000}
                className="reader-surface mt-2 w-full rounded-sm border p-3 text-lg"
              />
            </div>
            {navButtons(() => setStep('contact'), () => setStep('category'))}
          </form>
        )}

        {step === 'contact' && (
          <form onSubmit={(event) => event.preventDefault()}>
            {heading(strings.reportStepContact)}
            <div className="mt-4">
              <label htmlFor={`${ids}-email`} className="block text-lg font-bold">{strings.reportEmailLabel}</label>
              <p id={`${ids}-email-hint`} className="text-base opacity-85">{strings.reportEmailHint}</p>
              {emailError && (
                <p id={`${ids}-email-error`} role="alert" className="mt-2 text-lg font-bold">{strings.reportEmailInvalid}</p>
              )}
              <input
                id={`${ids}-email`}
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                aria-invalid={emailError || undefined}
                aria-describedby={emailError ? `${ids}-email-hint ${ids}-email-error` : `${ids}-email-hint`}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(false);
                }}
                maxLength={200}
                className="reader-surface mt-2 min-h-[56px] w-full rounded-sm border px-3 text-lg"
              />
            </div>
            {/* A box people never see or hear. Robots fill it in, and their reports are dropped. */}
            <div aria-hidden="true" className="sr-only">
              <label>
                {strings.reportHoneypotLabel}
                <input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} name="website" />
              </label>
            </div>
            {navButtons(() => {
              if (email.trim() && !EMAIL_RE.test(email.trim())) {
                setEmailError(true);
                return;
              }
              void goToReview();
            }, () => setStep('details'))}
          </form>
        )}

        {step === 'review' && report && (
          <div>
            {heading(strings.reportStepReview)}
            <p className="mt-3 text-lg">{strings.reportReviewIntro}</p>

            <section aria-labelledby={`${ids}-public`} className="mt-5 rounded-sm border p-4">
              <h3 id={`${ids}-public`} className="text-xl font-bold">{strings.reportPublicHeading}</h3>
              <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,16rem)_1fr]">
                <dt className="font-bold">{strings.reportReviewCategory}</dt>
                <dd>{categoryLabel(report.public.category)}</dd>
                <dt className="font-bold">{strings.reportReviewSymptoms}</dt>
                <dd>{symptomLabels(report).join('; ') || strings.reportNone}</dd>
                {(Object.entries(report.public.diagnostics) as Array<[DiagnosticKey, string | number | boolean]>).map(([key, value]) => (
                  <ReviewRow key={key} label={DIAGNOSTIC_LABELS[key]} value={formatDiagnosticValue(value)} />
                ))}
              </dl>
            </section>

            <section aria-labelledby={`${ids}-private`} className="mt-5 rounded-sm border p-4">
              <h3 id={`${ids}-private`} className="text-xl font-bold">{strings.reportPrivateHeading}</h3>
              <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,16rem)_1fr]">
                <ReviewRow label={strings.reportDetailsLabel} value={report.private.details || strings.reportNone} />
                <ReviewRow label={strings.reportStepsLabel} value={report.private.steps || strings.reportNone} />
                <ReviewRow label={strings.reportEmailLabel} value={report.private.email || strings.reportNone} />
              </dl>
            </section>

            <details className="mt-5">
              <summary className="cursor-pointer text-lg font-bold">{strings.reportRawHeading}</summary>
              <pre className="reader-surface mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-sm border p-3 text-sm">
                {JSON.stringify({ app: report.app, kind: report.kind, public: report.public, private: report.private }, null, 2)}
              </pre>
            </details>

            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" className={primary} onClick={() => void handleSend()}>{strings.reportSend}</button>
              <button type="button" className={secondary} onClick={() => setStep('contact')}>{strings.reportBack}</button>
              <button type="button" className={secondary} onClick={onClose}>{strings.reportCancel}</button>
            </div>
          </div>
        )}

        {step === 'sending' && heading(strings.reportSending)}

        {step === 'sent' && (
          <div>
            {heading(strings.reportSentHeading)}
            <p className="mt-3 text-lg">
              {strings.reportSentBody}
              {report?.private.email ? ` ${strings.reportSentReply}` : ''}
            </p>
            {issueUrl && (
              <p className="mt-4">
                <a href={issueUrl} target="_blank" rel="noopener noreferrer" className="text-lg font-bold underline">
                  {strings.reportIssueLink}
                </a>
              </p>
            )}
            <div className="mt-6">
              <button type="button" className={primary} onClick={onClose}>{strings.reportDone}</button>
            </div>
          </div>
        )}

        {step === 'fallback' && report && (
          <div>
            {heading(failure === 'offline' ? strings.reportOfflineHeading : strings.reportFailedHeading)}
            {failureMessage && <p className="mt-3 text-lg">{failureMessage}</p>}
            <p className="mt-3 text-lg">{strings.reportFallbackBody.replace('{inbox}', REPORT_INBOX)}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" className={primary} onClick={() => void handleCopy()}>{strings.reportCopy}</button>
              <button type="button" className={secondary} onClick={handleDownload}>{strings.reportDownload}</button>
              <a href={reportMailtoHref(report)} className={`${secondary} inline-flex items-center`}>{strings.reportEmailIt}</a>
              {online && (
                <button type="button" className={secondary} onClick={() => void handleSend()}>{strings.reportTryAgain}</button>
              )}
              <button type="button" className={secondary} onClick={onClose}>{strings.reportDone}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-bold">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{value}</dd>
    </>
  );
}
