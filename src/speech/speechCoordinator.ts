import { cleanTextForSpeech } from '../../shared/speechCleaner.ts';
import { strings } from '../../shared/strings.ts';
import type { DeviceClass, VoiceOrderPreference } from '../settings.ts';
import type { SpeechControlHandle } from './kokoroClient.ts';

export type VoiceProviderId = 'device' | 'kokoro';

export type SpeakCallbacks = {
  rate: number;
  voice?: string;
  deviceVoiceName?: string | null;
  online?: boolean;
  onStart?: (provider: VoiceProviderId) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
};

export type VoiceProvider = {
  id: VoiceProviderId;
  isReady: () => boolean;
  speak: (cleanedText: string, callbacks: SpeakCallbacks) => SpeechControlHandle;
};

export const KOKORO_FIRST_AUDIO_TIMEOUT_MS = 4000;

const NOVELTY_VOICES = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'fred',
  'good news',
  'jester',
  'junior',
  'kathy',
  'organ',
  'ralph',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
]);

const CURATED_NATURAL_NAMES = [
  'samantha',
  'ava',
  'daniel',
  'karen',
  'moira',
  'tessa',
  'rishi',
];

const ELOQUENCE_NAMES = [
  'reed',
  'sandy',
  'shelley',
  'flo',
  'eddy',
  'rocko',
  'grandma',
  'grandpa',
];

function isEnglishLang(lang: string): boolean {
  return /^en(?:[-_]|$)/i.test(lang.trim());
}

function matchesVoiceToken(voiceName: string, target: string): boolean {
  const lower = voiceName.trim().toLowerCase();
  return lower === target || lower.startsWith(`${target} `) || lower.startsWith(`${target}(`);
}

export function isNoveltyVoiceName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  if (NOVELTY_VOICES.has(lower)) return true;
  for (const novelty of NOVELTY_VOICES) {
    if (lower.startsWith(`${novelty} `) || lower.startsWith(`${novelty}(`)) {
      return true;
    }
  }
  return false;
}

export function isOnlineOnlyDeviceVoice(voice: Pick<SpeechSynthesisVoice, 'name'>): boolean {
  return /online|google/i.test(voice.name);
}

/**
 * Returns non-novelty English (`en-*`) voices in browser order (deduplicated by name).
 */
export function getAllowedEnglishDeviceVoices(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] {
  const seen = new Set<string>();
  const allowed: SpeechSynthesisVoice[] = [];
  for (const voice of voices) {
    if (!isEnglishLang(voice.lang) || isNoveltyVoiceName(voice.name)) continue;
    if (seen.has(voice.name)) continue;
    seen.add(voice.name);
    allowed.push(voice);
  }
  return allowed;
}

export function getDeviceVoiceShortName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'your voice';
  let cleaned = trimmed;
  if (/^microsoft\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^microsoft\s+/i, '');
    cleaned = cleaned.replace(/\s+online\b.*$/i, '');
    cleaned = cleaned.replace(/\s+desktop\b.*$/i, '');
    cleaned = cleaned.replace(/\s*-\s*english.*$/i, '');
    cleaned = cleaned.replace(/multilingual\s*$/i, '').trim();
  }
  cleaned = cleaned.replace(/\s*\(.*$/, '').trim();
  return cleaned || trimmed;
}

/**
 * Selects the best automatic English device voice following the v3 priority order,
 * excluding novelty voices and skipping online-only voices when offline.
 */
export function selectBestDeviceVoice(
  voices: readonly SpeechSynthesisVoice[],
  options: { online?: boolean } = {},
): SpeechSynthesisVoice | null {
  const online = options.online ?? true;
  const allowed = getAllowedEnglishDeviceVoices(voices);
  const eligible = online ? allowed : allowed.filter((v) => !isOnlineOnlyDeviceVoice(v));
  if (eligible.length === 0) return null;

  // 1. "Google UK English Female", then "Google US English" (when online)
  for (const googleName of ['google uk english female', 'google us english']) {
    const match = eligible.find((v) => matchesVoiceToken(v.name, googleName));
    if (match) return match;
  }

  // 2. Any voice with "Natural" in its name (e.g. Microsoft Edge online Natural voices)
  const natural = eligible.find((v) => /\bnatural\b/i.test(v.name));
  if (natural) return natural;

  // 3. "Allison (Enhanced)", then any other voice with "Premium" or "Enhanced"
  const allisonEnhanced = eligible.find((v) => matchesVoiceToken(v.name, 'allison (enhanced)'));
  if (allisonEnhanced) return allisonEnhanced;

  const premiumOrEnhanced = eligible.find((v) => /\b(?:premium|enhanced)\b/i.test(v.name));
  if (premiumOrEnhanced) return premiumOrEnhanced;

  // 4. Samantha, Ava, Daniel, Karen, Moira, Tessa, Rishi
  for (const curated of CURATED_NATURAL_NAMES) {
    const match = eligible.find((v) => matchesVoiceToken(v.name, curated));
    if (match) return match;
  }

  // 5. Eloquence voices: Reed, Sandy, Shelley, Flo, Eddy, Rocko, Grandma, Grandpa
  for (const eloquence of ELOQUENCE_NAMES) {
    const match = eligible.find((v) => matchesVoiceToken(v.name, eloquence));
    if (match) return match;
  }

  // 6. System default voice (excluding novelty), then any other English voice
  const systemDefault = eligible.find((v) => v.default);
  if (systemDefault) return systemDefault;

  return eligible[0] ?? null;
}

export function resolveDeviceVoice(
  voices: readonly SpeechSynthesisVoice[],
  options: { preferredVoiceName?: string | null; online?: boolean } = {},
): { voice: SpeechSynthesisVoice | null; preferredMissing: boolean } {
  const online = options.online ?? true;
  const preferred = options.preferredVoiceName?.trim();
  if (preferred) {
    const allowed = getAllowedEnglishDeviceVoices(voices);
    const match = allowed.find((v) => v.name.trim().toLowerCase() === preferred.toLowerCase());
    if (match && (online || !isOnlineOnlyDeviceVoice(match))) {
      return { voice: match, preferredMissing: false };
    }
    return {
      voice: selectBestDeviceVoice(voices, { online }),
      preferredMissing: true,
    };
  }

  return {
    voice: selectBestDeviceVoice(voices, { online }),
    preferredMissing: false,
  };
}

export function getBrowserDeviceVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  try {
    const voices = typeof window.speechSynthesis.getVoices === 'function'
      ? window.speechSynthesis.getVoices()
      : [];
    return getAllowedEnglishDeviceVoices(voices);
  } catch {
    return [];
  }
}

export function subscribeBrowserDeviceVoices(
  listener: (voices: SpeechSynthesisVoice[]) => void,
): () => void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return () => undefined;
  }
  const update = () => listener(getBrowserDeviceVoices());
  update();
  const synth = window.speechSynthesis;
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', update);
    return () => synth.removeEventListener?.('voiceschanged', update);
  }
  return () => undefined;
}

export function resolveVoiceOrder(
  deviceClass: DeviceClass,
  preference: VoiceOrderPreference,
  kokoroTooSlow = false,
): readonly VoiceProviderId[] {
  if (preference === 'device-first') return ['device', 'kokoro'];
  if (preference === 'kokoro-first') return ['kokoro', 'device'];
  if (kokoroTooSlow) return ['device', 'kokoro'];
  return deviceClass === 'phone' ? ['device', 'kokoro'] : ['kokoro', 'device'];
}

// Keep strong references so Chrome/Safari GC never collects utterances mid-speech.
const retainedUtterances = new Set<SpeechSynthesisUtterance>();

function pickCurrentVoice(
  synth: SpeechSynthesis,
  options?: { deviceVoiceName?: string | null; online?: boolean },
): SpeechSynthesisVoice | null {
  const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
  const online =
    options?.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
  return resolveDeviceVoice(voices, {
    preferredVoiceName: options?.deviceVoiceName,
    online,
  }).voice;
}

export const VOICES_WAIT_TIMEOUT_MS = 1500;

/**
 * Waits for speechSynthesis.getVoices() to become non-empty via the `voiceschanged`
 * event (up to `timeoutMs`, default 1.5 s) so Chrome never falls back to a robotic default.
 */
export function waitForDeviceVoices(
  synth: SpeechSynthesis,
  timeoutMs = VOICES_WAIT_TIMEOUT_MS,
): { promise: Promise<readonly SpeechSynthesisVoice[]>; cancel: () => void } {
  const initial = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
  if (initial.length > 0) {
    return {
      promise: Promise.resolve(initial),
      cancel: () => undefined,
    };
  }

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleanupListener: () => void = () => undefined;

  const promise = new Promise<readonly SpeechSynthesisVoice[]>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cleanupListener();
      const latest = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
      resolve(latest);
    };

    const onVoicesChanged = () => {
      const latest = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
      if (latest.length > 0) {
        finish();
      }
    };

    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', onVoicesChanged);
      cleanupListener = () => {
        synth.removeEventListener?.('voiceschanged', onVoicesChanged);
      };
    }

    timer = setTimeout(finish, timeoutMs);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cleanupListener();
    },
  };
}

export function createBrowserDeviceVoiceProvider(options?: {
  voicesWaitTimeoutMs?: number;
}): VoiceProvider {
  const hasSynth = () =>
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  // Trigger initial voice list loading once and keep it warm when voiceschanged fires.
  if (hasSynth()) {
    window.speechSynthesis.getVoices?.();
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        window.speechSynthesis.getVoices?.();
      });
    }
  }

  const voicesWaitTimeoutMs = options?.voicesWaitTimeoutMs ?? VOICES_WAIT_TIMEOUT_MS;

  return {
    id: 'device',
    isReady: hasSynth,
    speak(cleanedText, callbacks) {
      if (!hasSynth()) {
        const err = new Error('Browser speechSynthesis is unavailable');
        queueMicrotask(() => callbacks.onError?.(err));
        return { pause: () => undefined, resume: () => undefined, stop: () => undefined };
      }

      const trimmed = cleanedText.trim();
      if (!trimmed) {
        queueMicrotask(() => callbacks.onEnd?.());
        return { pause: () => undefined, resume: () => undefined, stop: () => undefined };
      }

      let stopped = false;
      let pendingStartTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelVoicesWait: () => void = () => undefined;
      const synth = window.speechSynthesis;
      const wasActive = Boolean(synth.speaking || synth.pending);

      if (wasActive) {
        synth.cancel();
      }

      // Send the full text as ONE utterance with zero chunk splitting and no keepalive timers.
      const speakSingleUtterance = (voices: readonly SpeechSynthesisVoice[]) => {
        if (stopped) return;
        const online =
          callbacks.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
        const selectedVoice = resolveDeviceVoice(voices, {
          preferredVoiceName: callbacks.deviceVoiceName,
          online,
        }).voice;

        const utterance = new SpeechSynthesisUtterance(trimmed);
        utterance.rate = callbacks.rate;
        utterance.lang = selectedVoice?.lang || strings.language;
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        retainedUtterances.add(utterance);

        utterance.onstart = () => {
          if (stopped) return;
          callbacks.onStart?.('device');
        };

        utterance.onend = () => {
          retainedUtterances.delete(utterance);
          if (stopped) return;
          callbacks.onEnd?.();
        };

        utterance.onerror = () => {
          retainedUtterances.delete(utterance);
          if (stopped) return;
          callbacks.onError?.(new Error('Device voice failed'));
        };

        synth.speak(utterance);
      };

      const initialVoices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
      if (initialVoices.length === 0) {
        const waiter = waitForDeviceVoices(synth, voicesWaitTimeoutMs);
        cancelVoicesWait = waiter.cancel;
        void waiter.promise.then((loadedVoices) => {
          if (stopped) return;
          speakSingleUtterance(loadedVoices);
        });
      } else if (wasActive) {
        // Avoid Chrome's synchronous cancel()-then-speak() drop bug when interrupting active speech.
        pendingStartTimer = setTimeout(() => {
          pendingStartTimer = null;
          speakSingleUtterance(typeof synth.getVoices === 'function' ? synth.getVoices() : initialVoices);
        }, 40);
      } else {
        speakSingleUtterance(initialVoices);
      }

      return {
        pause: () => {
          if (!stopped) synth.pause();
        },
        resume: () => {
          if (!stopped) synth.resume();
        },
        stop: () => {
          stopped = true;
          cancelVoicesWait();
          if (pendingStartTimer !== null) {
            clearTimeout(pendingStartTimer);
            pendingStartTimer = null;
          }
          retainedUtterances.clear();
          if (synth.speaking || synth.pending) {
            synth.cancel();
          }
        },
      };
    },
  };
}

export type SpeechStatusSnapshot = {
  speaking: boolean;
  paused: boolean;
  activeProvider: VoiceProviderId | null;
};

export type UnlockCueOptions = {
  deviceVoiceName?: string | null;
  online?: boolean;
};

export type CoordinatorDeps = {
  deviceProvider: VoiceProvider;
  kokoroProvider: VoiceProvider;
  unlockAudioContext: () => void;
  playClickSound?: () => void;
  unlockDeviceCue?: (cueText: string, options?: UnlockCueOptions) => void;
  firstAudioTimeoutMs?: number;
};

export function createDefaultUnlockCue(): (cueText: string, options?: UnlockCueOptions) => void {
  return (cueText: string, options?: UnlockCueOptions) => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      return;
    }
    try {
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) {
        synth.cancel();
      }
      const cue = new SpeechSynthesisUtterance(cueText);
      cue.rate = 1.05;
      const voice = pickCurrentVoice(synth, {
        deviceVoiceName: options?.deviceVoiceName,
        online: options?.online,
      });
      cue.lang = voice?.lang || strings.language;
      if (voice) {
        cue.voice = voice;
      }
      retainedUtterances.add(cue);
      cue.onend = () => retainedUtterances.delete(cue);
      cue.onerror = () => retainedUtterances.delete(cue);
      synth.speak(cue);
    } catch {
      // Ignore if speechSynthesis is blocked.
    }
  };
}

export class SpeechCoordinator {
  private deps: CoordinatorDeps;
  private activeHandle: SpeechControlHandle | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobId = 0;
  private snapshot: SpeechStatusSnapshot = {
    speaking: false,
    paused: false,
    activeProvider: null,
  };
  private listeners = new Set<(status: SpeechStatusSnapshot) => void>();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  getStatus(): SpeechStatusSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (status: SpeechStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private clearWatchdog() {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private updateSnapshot(next: SpeechStatusSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /**
   * Synchronously unlocks iOS speechSynthesis & Web AudioContext inside capture
   * shutter tap handlers (speaks short "Describing" cue using the chosen/automatic device voice).
   */
  unlockOnCaptureTap({
    speakCue,
    deviceVoiceName,
    online,
  }: {
    speakCue: boolean;
    deviceVoiceName?: string | null;
    online?: boolean;
  }): void {
    this.stop();
    this.deps.unlockAudioContext();
    if (speakCue) {
      const unlockCue = this.deps.unlockDeviceCue ?? createDefaultUnlockCue();
      unlockCue(strings.statusShortCue, { deviceVoiceName, online });
    }
  }

  /**
   * Silently unlocks/resumes Web AudioContext for playback & preview taps without
   * speaking "Describing".
   */
  unlockAudioOnly(): void {
    this.deps.unlockAudioContext();
  }

  playSettingsClick(): void {
    this.deps.unlockAudioContext();
    this.deps.playClickSound?.();
  }

  speakJob(
    rawText: string,
    {
      deviceClass,
      voiceOrder,
      rate,
      kokoroVoiceId,
      deviceVoiceName,
      online,
      kokoroAllowed = true,
      kokoroTooSlow = false,
      forceProvider,
      onProviderStarted,
    }: {
      deviceClass: DeviceClass;
      voiceOrder: VoiceOrderPreference;
      rate: number;
      kokoroVoiceId: string;
      deviceVoiceName?: string | null;
      online?: boolean;
      kokoroAllowed?: boolean;
      kokoroTooSlow?: boolean;
      forceProvider?: VoiceProviderId;
      onProviderStarted?: (provider: VoiceProviderId) => void;
    },
  ): VoiceProviderId | null {
    this.stop();
    const cleaned = cleanTextForSpeech(rawText);
    if (!cleaned) return null;

    const jobId = ++this.activeJobId;
    const providersById: Record<VoiceProviderId, VoiceProvider> = {
      device: this.deps.deviceProvider,
      kokoro: this.deps.kokoroProvider,
    };

    const order: readonly VoiceProviderId[] = forceProvider
      ? [forceProvider]
      : resolveVoiceOrder(deviceClass, voiceOrder, kokoroTooSlow);

    const readyChain = order
      .map((id) => providersById[id])
      .filter((provider) => {
        if (provider.id === 'kokoro' && !kokoroAllowed) return false;
        return provider.isReady();
      });

    if (readyChain.length === 0) {
      this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
      return null;
    }

    const firstAudioTimeoutMs = this.deps.firstAudioTimeoutMs ?? KOKORO_FIRST_AUDIO_TIMEOUT_MS;
    // Lock one voice per job: once a provider starts audible playback, never switch mid-job.
    let started = false;
    let index = 0;

    const tryNext = (): VoiceProviderId | null => {
      this.clearWatchdog();
      if (jobId !== this.activeJobId || index >= readyChain.length) {
        if (jobId === this.activeJobId) {
          this.activeHandle = null;
          this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
        }
        return null;
      }

      const provider = readyChain[index++];
      let timedOutThisAttempt = false;

      this.updateSnapshot({
        speaking: true,
        paused: false,
        activeProvider: provider.id,
      });

      // Start the 4-second first-audio timeout whenever trying Kokoro with another provider behind it.
      if (provider.id === 'kokoro' && index < readyChain.length) {
        this.watchdogTimer = setTimeout(() => {
          this.watchdogTimer = null;
          if (jobId !== this.activeJobId || started) return;
          timedOutThisAttempt = true;
          const handleToCancel = this.activeHandle;
          this.activeHandle = null;
          handleToCancel?.stop();
          tryNext();
        }, firstAudioTimeoutMs);
      }

      try {
        const handle = provider.speak(cleaned, {
          rate,
          voice: kokoroVoiceId,
          deviceVoiceName,
          online,
          onStart: () => {
            if (jobId !== this.activeJobId || timedOutThisAttempt) return;
            this.clearWatchdog();
            started = true;
            this.updateSnapshot({
              speaking: true,
              paused: false,
              activeProvider: provider.id,
            });
            onProviderStarted?.(provider.id);
          },
          onEnd: () => {
            if (jobId !== this.activeJobId || timedOutThisAttempt) return;
            this.clearWatchdog();
            this.activeHandle = null;
            this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
          },
          onError: () => {
            if (jobId !== this.activeJobId || timedOutThisAttempt) return;
            this.clearWatchdog();
            this.activeHandle = null;
            if (!started && index < readyChain.length) {
              tryNext();
              return;
            }
            this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
          },
        });
        if (!timedOutThisAttempt && jobId === this.activeJobId) {
          this.activeHandle = handle;
        } else {
          handle.stop();
        }
        return provider.id;
      } catch {
        this.clearWatchdog();
        this.activeHandle = null;
        if (!started && index < readyChain.length) {
          return tryNext();
        }
        this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
        return null;
      }
    };

    return tryNext();
  }

  pause(): void {
    if (!this.snapshot.speaking || this.snapshot.paused || !this.activeHandle) return;
    this.activeHandle.pause();
    this.updateSnapshot({ ...this.snapshot, paused: true });
  }

  resume(): void {
    if (!this.snapshot.speaking || !this.snapshot.paused || !this.activeHandle) return;
    this.activeHandle.resume();
    this.updateSnapshot({ ...this.snapshot, paused: false });
  }

  togglePause(): 'paused' | 'resumed' | 'none' {
    if (!this.snapshot.speaking) return 'none';
    if (this.snapshot.paused) {
      this.resume();
      return 'resumed';
    }
    this.pause();
    return 'paused';
  }

  stop(): void {
    this.activeJobId += 1;
    this.clearWatchdog();
    if (this.activeHandle) {
      this.activeHandle.stop();
      this.activeHandle = null;
    }
    if (this.snapshot.speaking || this.snapshot.paused || this.snapshot.activeProvider !== null) {
      this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
    }
  }
}
