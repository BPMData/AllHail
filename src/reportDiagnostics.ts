import type { Diagnostics } from '../shared/report.ts';
import { safeStatusMessage, sanitizeDiagnostics } from '../shared/report.ts';
import type { AppSettings, DeviceClass } from './settings.ts';
import type { KokoroState } from './speech/kokoroClient.ts';
import type { PiperState } from './speech/piperClient.ts';

declare const __APP_VERSION__: string | undefined;
declare const __APP_BUILT__: string | undefined;

/** App state the report may describe. Deliberately has no photo, description, history or voice-name fields. */
export type ReportContext = {
  deviceClass: DeviceClass;
  online: boolean;
  offlineReady: boolean;
  updateWaiting: boolean;
  settings: AppSettings;
  deviceVoiceCount: number;
  deviceVoiceMissing: boolean;
  activeVoice: string;
  lastVoiceUsed: string | null;
  speaking: boolean;
  kokoroState: KokoroState;
  piperState: PiperState;
  descriptionMode: string;
  lastStatus: string;
};

/** "Chrome 131", "Safari 18" … from the user agent. Good enough to sort reports, not a fingerprint. */
export function describeBrowser(ua: string): { browser: string; os: string } {
  const version = (re: RegExp) => re.exec(ua)?.[1] ?? '';
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = `Edge ${version(/Edg\/(\d+)/)}`;
  else if (/SamsungBrowser\//.test(ua)) browser = `Samsung Internet ${version(/SamsungBrowser\/(\d+)/)}`;
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = `Firefox ${version(/(?:Firefox|FxiOS)\/(\d+)/)}`;
  else if (/CriOS\//.test(ua)) browser = `Chrome ${version(/CriOS\/(\d+)/)}`;
  else if (/Chrome\//.test(ua)) browser = `Chrome ${version(/Chrome\/(\d+)/)}`;
  else if (/Safari\//.test(ua)) browser = `Safari ${version(/Version\/(\d+(?:\.\d+)?)/)}`;

  let os = 'Unknown system';
  if (/iPhone|iPad|iPod/.test(ua)) os = `iOS ${version(/OS (\d+(?:_\d+)?)/).replace('_', '.')}`;
  else if (/Android/.test(ua)) os = `Android ${version(/Android (\d+(?:\.\d+)?)/)}`;
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser: browser.trim(), os: os.trim() };
}

function media(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

async function cameraPermission(): Promise<string> {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export async function collectDiagnostics(context: ReportContext): Promise<Diagnostics> {
  const ua = navigator.userAgent ?? '';
  const { browser, os } = describeBrowser(ua);
  const nav = navigator as Navigator & { gpu?: unknown; standalone?: boolean };
  const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return sanitizeDiagnostics({
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    appBuilt: typeof __APP_BUILT__ === 'string' ? __APP_BUILT__ : 'unknown',
    language: navigator.language,
    browser,
    os,
    userAgent: ua,
    deviceClass: context.deviceClass,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    pixelRatio: window.devicePixelRatio,
    textSizePx: Number.isFinite(rootFont) ? rootFont : undefined,
    touchPoints: navigator.maxTouchPoints ?? 0,
    coarsePointer: media('(pointer: coarse)'),
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    darkMode: media('(prefers-color-scheme: dark)'),
    moreContrast: media('(prefers-contrast: more)'),
    online: context.online,
    installed: media('(display-mode: standalone)') || nav.standalone === true,
    offlineReady: context.offlineReady,
    serviceWorkerActive: Boolean(navigator.serviceWorker?.controller),
    updateWaiting: context.updateWaiting,
    cameraSupported: typeof navigator.mediaDevices?.getUserMedia === 'function',
    cameraPermission: await cameraPermission(),
    speechSupported: typeof window.speechSynthesis !== 'undefined',
    deviceVoiceCount: context.deviceVoiceCount,
    deviceVoiceChosen: Boolean(context.settings.deviceVoiceName),
    deviceVoiceMissing: context.deviceVoiceMissing,
    webgpu: Boolean(nav.gpu),
    storageSupported: typeof indexedDB !== 'undefined',
    activeVoice: context.activeVoice,
    lastVoiceUsed: context.lastVoiceUsed ?? 'none',
    speaking: context.speaking,
    kokoroStatus: context.kokoroState.status,
    kokoroProgress: context.kokoroState.progress,
    kokoroTooSlow: context.kokoroState.tooSlow,
    piperStatus: context.piperState.status,
    piperProgress: context.piperState.progress,
    piperTooSlow: context.piperState.tooSlow,
    autoRead: context.settings.autoRead,
    speechRate: context.settings.speechRate,
    voiceOrder: context.settings.voiceOrder,
    kokoroOnPhone: context.settings.kokoroEnabledOnPhone,
    piperOnPhone: context.settings.piperEnabledOnPhone,
    kokoroVoice: context.settings.kokoroVoiceId,
    editingDisabled: context.settings.disableEditing,
    descriptionMode: context.descriptionMode,
    lastStatus: safeStatusMessage(context.lastStatus),
  });
}
