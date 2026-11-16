export type DeviceClass = 'phone' | 'laptop';
export type VoiceOrderPreference = 'auto' | 'device-first' | 'kokoro-first' | 'piper-first';

export type AppSettings = {
  autoRead: boolean;
  speechRate: number;
  voiceOrder: VoiceOrderPreference;
  deviceVoiceName: string | null;
  kokoroEnabledOnPhone: boolean;
  piperEnabledOnPhone: boolean;
  kokoroVoiceId: string;
};

export const KOKORO_VOICES = [
  { id: 'af_heart', shortName: 'Heart', label: 'Heart (US English)' },
  { id: 'af_bella', shortName: 'Bella', label: 'Bella (US English)' },
  { id: 'am_michael', shortName: 'Michael', label: 'Michael (US English)' },
  { id: 'bf_emma', shortName: 'Emma', label: 'Emma (British English)' },
  { id: 'bm_george', shortName: 'George', label: 'George (British English)' },
] as const;

export const SPEECH_RATES = [0.8, 1.0, 1.25, 1.5, 2.0] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  autoRead: true,
  speechRate: 1.0,
  voiceOrder: 'auto',
  deviceVoiceName: null,
  kokoroEnabledOnPhone: false,
  piperEnabledOnPhone: false,
  kokoroVoiceId: 'af_heart',
};

const STORAGE_KEY = 'allhail-settings-v1';

export type DeviceCapabilities = {
  maxTouchPoints?: number;
  coarsePointer?: boolean;
  viewportWidth?: number;
  deviceMemory?: number;
  hasWebGPU?: boolean;
};

/**
 * Classifies phone vs laptop by capabilities (touch/pointer, screen, memory, WebGPU),
 * never by user-agent brand names.
 */
export function detectDeviceClass(caps?: DeviceCapabilities): DeviceClass {
  const maxTouchPoints =
    caps?.maxTouchPoints ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0);
  const coarsePointer =
    caps?.coarsePointer ??
    (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false);
  const viewportWidth =
    caps?.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1024);
  const deviceMemory =
    caps?.deviceMemory ??
    (typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? Number((navigator as { deviceMemory?: number }).deviceMemory)
      : undefined);
  const hasWebGPU =
    caps?.hasWebGPU ?? (typeof navigator !== 'undefined' && 'gpu' in navigator);

  const touchPrimary = coarsePointer || (maxTouchPoints > 0 && viewportWidth < 900);
  if (touchPrimary && (viewportWidth < 900 || (typeof deviceMemory === 'number' && deviceMemory <= 4) || !hasWebGPU)) {
    return 'phone';
  }
  return 'laptop';
}

export function loadSettings(): AppSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const rate = typeof parsed.speechRate === 'number' && parsed.speechRate >= 0.5 && parsed.speechRate <= 2.5
      ? parsed.speechRate
      : DEFAULT_SETTINGS.speechRate;
    const voiceOrder: VoiceOrderPreference =
      parsed.voiceOrder === 'device-first' ||
      parsed.voiceOrder === 'kokoro-first' ||
      parsed.voiceOrder === 'piper-first' ||
      parsed.voiceOrder === 'auto'
        ? parsed.voiceOrder
        : DEFAULT_SETTINGS.voiceOrder;
    const kokoroVoiceId = KOKORO_VOICES.some((v) => v.id === parsed.kokoroVoiceId)
      ? (parsed.kokoroVoiceId as string)
      : DEFAULT_SETTINGS.kokoroVoiceId;

    const deviceVoiceName =
      typeof parsed.deviceVoiceName === 'string' && parsed.deviceVoiceName.trim().length > 0
        ? parsed.deviceVoiceName.trim()
        : null;

    return {
      autoRead: typeof parsed.autoRead === 'boolean' ? parsed.autoRead : DEFAULT_SETTINGS.autoRead,
      speechRate: rate,
      voiceOrder,
      deviceVoiceName,
      kokoroEnabledOnPhone:
        typeof parsed.kokoroEnabledOnPhone === 'boolean'
          ? parsed.kokoroEnabledOnPhone
          : DEFAULT_SETTINGS.kokoroEnabledOnPhone,
      piperEnabledOnPhone:
        typeof parsed.piperEnabledOnPhone === 'boolean'
          ? parsed.piperEnabledOnPhone
          : DEFAULT_SETTINGS.piperEnabledOnPhone,
      kokoroVoiceId,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
  } catch {
    // Ignore storage quota or private-mode errors gracefully.
  }
}
