// The "Something not working?" report: what it holds, which part is public, and how it is cleaned.
// Shared by the browser (builds the report and shows it before sending) and the server (checks it
// before passing it to the relay). Server code runs with Node type stripping: no enums here.
import { strings } from './strings.ts';

export const REPORT_APP = 'AllHail';
export const REPORT_KIND = 'problem-report';
/** The shared reports inbox (also used by OverBoard). Manual fallback reports go here too. */
export const REPORT_INBOX = 'overboard.reporting@gmail.com';

export const MAX_DETAILS_CHARS = 4000;
export const MAX_EMAIL_CHARS = 200;

type Choice = { id: string; label: string };

/** What went wrong. Each category has a short list of things the person can tick. */
export const REPORT_CATEGORIES: ReadonlyArray<Choice & { symptoms: readonly Choice[] }> = [
  {
    id: 'camera',
    label: strings.reportCatCamera,
    symptoms: [
      { id: 'camera-wont-open', label: strings.reportSymCameraWontOpen },
      { id: 'camera-blocked', label: strings.reportSymCameraBlocked },
      { id: 'choose-photo-failed', label: strings.reportSymChoosePhotoFailed },
      { id: 'photo-prep-failed', label: strings.reportSymPhotoPrepFailed },
      { id: 'screen-froze', label: strings.reportSymScreenFroze },
    ],
  },
  {
    id: 'descriptions',
    label: strings.reportCatDescriptions,
    symptoms: [
      { id: 'no-description', label: strings.reportSymNoDescription },
      { id: 'error-shown', label: strings.reportSymErrorShown },
      { id: 'very-slow', label: strings.reportSymVerySlow },
      { id: 'description-wrong', label: strings.reportSymDescriptionWrong },
      { id: 'description-cut-off', label: strings.reportSymDescriptionCutOff },
    ],
  },
  {
    id: 'speech',
    label: strings.reportCatSpeech,
    symptoms: [
      { id: 'nothing-read', label: strings.reportSymNothingRead },
      { id: 'wrong-voice', label: strings.reportSymWrongVoice },
      { id: 'voice-download-stuck', label: strings.reportSymVoiceDownloadStuck },
      { id: 'speech-stopped', label: strings.reportSymSpeechStopped },
      { id: 'controls-failed', label: strings.reportSymControlsFailed },
      { id: 'mp3-failed', label: strings.reportSymMp3Failed },
    ],
  },
  {
    id: 'offline',
    label: strings.reportCatOffline,
    symptoms: [
      { id: 'wont-install', label: strings.reportSymWontInstall },
      { id: 'wont-open-offline', label: strings.reportSymWontOpenOffline },
      { id: 'update-failed', label: strings.reportSymUpdateFailed },
    ],
  },
  {
    id: 'history',
    label: strings.reportCatHistory,
    symptoms: [
      { id: 'history-missing', label: strings.reportSymHistoryMissing },
      { id: 'history-wont-play', label: strings.reportSymHistoryWontPlay },
      { id: 'history-delete-failed', label: strings.reportSymHistoryDeleteFailed },
    ],
  },
  {
    id: 'access',
    label: strings.reportCatAccess,
    symptoms: [
      { id: 'control-not-named', label: strings.reportSymControlNotNamed },
      { id: 'change-not-announced', label: strings.reportSymChangeNotAnnounced },
      { id: 'cant-reach-control', label: strings.reportSymCantReachControl },
      { id: 'large-text-broken', label: strings.reportSymLargeTextBroken },
    ],
  },
  { id: 'other', label: strings.reportCatOther, symptoms: [] },
];

export function findCategory(id: string) {
  return REPORT_CATEGORIES.find((category) => category.id === id);
}

/**
 * Diagnostics: only facts about the app, the browser and their features. Never photos, descriptions,
 * history, voice names or anything the person typed. Each key has one allowed type; anything else is dropped.
 */
export const DIAGNOSTIC_FIELDS = {
  appVersion: 'string',
  appBuilt: 'string',
  language: 'string',
  browser: 'string',
  os: 'string',
  userAgent: 'string',
  deviceClass: 'string',
  viewport: 'string',
  pixelRatio: 'number',
  textSizePx: 'number',
  touchPoints: 'number',
  coarsePointer: 'boolean',
  reducedMotion: 'boolean',
  darkMode: 'boolean',
  moreContrast: 'boolean',
  online: 'boolean',
  installed: 'boolean',
  offlineReady: 'boolean',
  serviceWorkerActive: 'boolean',
  updateWaiting: 'boolean',
  cameraSupported: 'boolean',
  cameraPermission: 'string',
  speechSupported: 'boolean',
  deviceVoiceCount: 'number',
  deviceVoiceChosen: 'boolean',
  deviceVoiceMissing: 'boolean',
  webgpu: 'boolean',
  storageSupported: 'boolean',
  activeVoice: 'string',
  lastVoiceUsed: 'string',
  speaking: 'boolean',
  kokoroStatus: 'string',
  kokoroProgress: 'number',
  kokoroTooSlow: 'boolean',
  piperStatus: 'string',
  piperProgress: 'number',
  piperTooSlow: 'boolean',
  autoRead: 'boolean',
  speechRate: 'number',
  voiceOrder: 'string',
  kokoroOnPhone: 'boolean',
  piperOnPhone: 'boolean',
  kokoroVoice: 'string',
  editingDisabled: 'boolean',
  descriptionMode: 'string',
  lastStatus: 'string',
} as const;

export type DiagnosticKey = keyof typeof DIAGNOSTIC_FIELDS;
export type Diagnostics = Partial<Record<DiagnosticKey, string | number | boolean>>;

/** Plain-language names for the review screen and the public issue. */
export const DIAGNOSTIC_LABELS: Record<DiagnosticKey, string> = {
  appVersion: 'AllHail version',
  appBuilt: 'Built',
  language: 'Browser language',
  browser: 'Browser',
  os: 'System',
  userAgent: 'Browser details',
  deviceClass: 'Device type',
  viewport: 'Window size',
  pixelRatio: 'Screen scale',
  textSizePx: 'Text size (px)',
  touchPoints: 'Touch points',
  coarsePointer: 'Touch screen',
  reducedMotion: 'Reduce motion on',
  darkMode: 'Dark mode on',
  moreContrast: 'More contrast on',
  online: 'Online',
  installed: 'Installed as an app',
  offlineReady: 'Saved for offline use',
  serviceWorkerActive: 'Offline helper running',
  updateWaiting: 'Update waiting',
  cameraSupported: 'Camera available to the browser',
  cameraPermission: 'Camera permission',
  speechSupported: 'Device voices available',
  deviceVoiceCount: 'Number of device voices',
  deviceVoiceChosen: 'A device voice was chosen',
  deviceVoiceMissing: 'Chosen device voice missing',
  webgpu: 'WebGPU available',
  storageSupported: 'On-device storage available',
  activeVoice: 'Active voice',
  lastVoiceUsed: 'Last voice used',
  speaking: 'Speaking when the report started',
  kokoroStatus: 'Kokoro voice',
  kokoroProgress: 'Kokoro download (%)',
  kokoroTooSlow: 'Kokoro too slow',
  piperStatus: 'Piper voice',
  piperProgress: 'Piper download (%)',
  piperTooSlow: 'Piper too slow',
  autoRead: 'Read aloud automatically',
  speechRate: 'Speech speed',
  voiceOrder: 'Voice order',
  kokoroOnPhone: 'Kokoro turned on (phone)',
  piperOnPhone: 'Piper turned on (phone)',
  kokoroVoice: 'Kokoro voice style',
  editingDisabled: 'Editing turned off',
  descriptionMode: 'Description mode',
  lastStatus: 'Last app message',
};

export type ReportPublic = {
  category: string;
  symptoms: string[];
  diagnostics: Diagnostics;
};

export type ReportPrivate = {
  details: string;
  steps: string;
  email: string;
};

export type ProblemReport = {
  app: typeof REPORT_APP;
  kind: typeof REPORT_KIND;
  public: ReportPublic;
  private: ReportPrivate;
  /** A box people never see. Robots fill it in. */
  website?: string;
};

export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Status messages are only reported when they are the app's own words (or its error prefix followed
 * by its own words), so nothing the person or a model wrote can slip in.
 */
const KNOWN_MESSAGES = new Set<string>(Object.values(strings as Record<string, unknown>).filter((value): value is string => typeof value === 'string'));
export function safeStatusMessage(message: string): string {
  const text = message.trim();
  if (!text) return '';
  if (KNOWN_MESSAGES.has(text)) return text;
  if (text.startsWith(strings.statusErrorPrefix)) {
    const rest = text.slice(strings.statusErrorPrefix.length).trim();
    if (!rest || KNOWN_MESSAGES.has(rest)) return text;
    return strings.statusErrorPrefix;
  }
  return strings.reportOtherMessage;
}

function cleanLine(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Keep line breaks in free text, drop other control characters.
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

export function sanitizeDiagnostics(input: unknown): Diagnostics {
  const out: Diagnostics = {};
  if (!input || typeof input !== 'object') return out;
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(DIAGNOSTIC_FIELDS) as DiagnosticKey[]) {
    const value = source[key];
    const type = DIAGNOSTIC_FIELDS[key];
    if (type === 'string' && typeof value === 'string') {
      const text = cleanLine(value, key === 'userAgent' ? 400 : 160);
      if (text) out[key] = key === 'lastStatus' ? safeStatusMessage(text) : text;
    } else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.round(value * 100) / 100;
    } else if (type === 'boolean' && typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Checks and cleans a report. Returns null when it isn't a real AllHail report.
 * Unknown categories, symptoms and diagnostic keys are dropped; text is trimmed to size.
 */
export function sanitizeReport(input: unknown): ProblemReport | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (raw.app !== REPORT_APP || raw.kind !== REPORT_KIND) return null;
  const pub = (raw.public && typeof raw.public === 'object' ? raw.public : {}) as Record<string, unknown>;
  const priv = (raw.private && typeof raw.private === 'object' ? raw.private : {}) as Record<string, unknown>;
  const category = findCategory(typeof pub.category === 'string' ? pub.category : '');
  if (!category) return null;
  const allowed = new Set(category.symptoms.map((symptom) => symptom.id));
  const symptoms = Array.isArray(pub.symptoms)
    ? [...new Set(pub.symptoms.filter((id): id is string => typeof id === 'string' && allowed.has(id)))]
    : [];
  const email = cleanLine(typeof priv.email === 'string' ? priv.email : '', MAX_EMAIL_CHARS);
  return {
    app: REPORT_APP,
    kind: REPORT_KIND,
    public: { category: category.id, symptoms, diagnostics: sanitizeDiagnostics(pub.diagnostics) },
    private: {
      details: cleanText(priv.details, MAX_DETAILS_CHARS),
      steps: cleanText(priv.steps, MAX_DETAILS_CHARS),
      email: EMAIL_RE.test(email) ? email : '',
    },
    website: typeof raw.website === 'string' ? raw.website.slice(0, 200) : '',
  };
}

export function buildReport({
  category,
  symptoms,
  details,
  steps,
  email,
  diagnostics,
  website = '',
}: {
  category: string;
  symptoms: readonly string[];
  details: string;
  steps: string;
  email: string;
  diagnostics: Diagnostics;
  website?: string;
}): ProblemReport | null {
  return sanitizeReport({
    app: REPORT_APP,
    kind: REPORT_KIND,
    public: { category, symptoms: [...symptoms], diagnostics },
    private: { details, steps, email: email.trim() },
    website,
  });
}

export function categoryLabel(id: string): string {
  return findCategory(id)?.label ?? id;
}

export function symptomLabels(report: ProblemReport): string[] {
  const category = findCategory(report.public.category);
  return report.public.symptoms.map((id) => category?.symptoms.find((symptom) => symptom.id === id)?.label ?? id);
}

export function formatDiagnosticValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? strings.reportYes : strings.reportNo;
  return String(value);
}

/** The report as plain text, for Copy, Download and the email fallback. Public and private parts are kept apart. */
export function formatReportText(report: ProblemReport): string {
  const symptoms = symptomLabels(report);
  const diagnostics = Object.entries(report.public.diagnostics) as Array<[DiagnosticKey, string | number | boolean]>;
  const none = strings.reportNone;
  return [
    `${REPORT_APP} problem report`,
    '',
    `== ${strings.reportPublicHeading} ==`,
    `${strings.reportReviewCategory}: ${categoryLabel(report.public.category)}`,
    `${strings.reportReviewSymptoms}: ${symptoms.length ? symptoms.join('; ') : none}`,
    ...diagnostics.map(([key, value]) => `${DIAGNOSTIC_LABELS[key]}: ${formatDiagnosticValue(value)}`),
    '',
    `== ${strings.reportPrivateHeading} ==`,
    `${strings.reportDetailsLabel}: ${report.private.details || none}`,
    `${strings.reportStepsLabel}: ${report.private.steps || none}`,
    `${strings.reportEmailLabel}: ${report.private.email || none}`,
    '',
    `${strings.reportRawHeading}:`,
    JSON.stringify({ app: report.app, kind: report.kind, public: report.public, private: report.private }, null, 1),
  ].join('\n');
}

export function reportEmailSubject(report: ProblemReport): string {
  return `${REPORT_APP} problem report: ${categoryLabel(report.public.category)}`;
}

/** A mailto: link to the shared inbox. Mail apps cut long links short, so the body is capped. */
export function reportMailtoHref(report: ProblemReport): string {
  const body = formatReportText(report).slice(0, 1800);
  return `mailto:${REPORT_INBOX}?subject=${encodeURIComponent(reportEmailSubject(report))}&body=${encodeURIComponent(body)}`;
}
