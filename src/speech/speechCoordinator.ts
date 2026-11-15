import { cleanTextForSpeech } from '../../shared/speechCleaner.ts';
import { strings } from '../../shared/strings.ts';
import type { DeviceClass, VoiceOrderPreference } from '../settings.ts';
import type { SpeechControlHandle } from './kokoroClient.ts';

export type VoiceProviderId = 'device' | 'kokoro';

export type SpeakCallbacks = {
  rate: number;
  voice?: string;
  onStart?: (provider: VoiceProviderId) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
};

export type VoiceProvider = {
  id: VoiceProviderId;
  isReady: () => boolean;
  speak: (cleanedText: string, callbacks: SpeakCallbacks) => SpeechControlHandle;
};

export function resolveVoiceOrder(
  deviceClass: DeviceClass,
  preference: VoiceOrderPreference,
): readonly VoiceProviderId[] {
  if (preference === 'device-first') return ['device', 'kokoro'];
  if (preference === 'kokoro-first') return ['kokoro', 'device'];
  return deviceClass === 'phone' ? ['device', 'kokoro'] : ['kokoro', 'device'];
}

export function createBrowserDeviceVoiceProvider(): VoiceProvider {
  const hasSynth = () =>
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  return {
    id: 'device',
    isReady: hasSynth,
    speak(cleanedText, callbacks) {
      if (!hasSynth()) {
        const err = new Error('Browser speechSynthesis is unavailable');
        queueMicrotask(() => callbacks.onError?.(err));
        return { pause: () => undefined, resume: () => undefined, stop: () => undefined };
      }

      let stopped = false;
      const synth = window.speechSynthesis;
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(cleanedText);
      utterance.rate = callbacks.rate;
      utterance.lang = strings.language;

      // Pick a local/English voice when available for steadier pronunciation.
      const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
      const localEn =
        voices.find((v) => v.localService && v.lang.toLowerCase().startsWith('en')) ??
        voices.find((v) => v.lang.toLowerCase().startsWith('en'));
      if (localEn) {
        utterance.voice = localEn;
      }

      utterance.onstart = () => {
        if (!stopped) callbacks.onStart?.('device');
      };
      utterance.onend = () => {
        if (!stopped) callbacks.onEnd?.();
      };
      utterance.onerror = () => {
        if (!stopped) callbacks.onError?.(new Error('Device voice failed'));
      };

      synth.speak(utterance);

      return {
        pause: () => {
          if (!stopped) synth.pause();
        },
        resume: () => {
          if (!stopped) synth.resume();
        },
        stop: () => {
          stopped = true;
          synth.cancel();
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

export type CoordinatorDeps = {
  deviceProvider: VoiceProvider;
  kokoroProvider: VoiceProvider;
  unlockAudioContext: () => void;
  unlockDeviceCue?: (cueText: string) => void;
};

export function createDefaultUnlockCue(): (cueText: string) => void {
  return (cueText: string) => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      return;
    }
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const cue = new SpeechSynthesisUtterance(cueText);
      cue.lang = strings.language;
      cue.rate = 1.05;
      synth.speak(cue);
    } catch {
      // Ignore if speechSynthesis is blocked.
    }
  };
}

export class SpeechCoordinator {
  private deps: CoordinatorDeps;
  private activeHandle: SpeechControlHandle | null = null;
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

  private updateSnapshot(next: SpeechStatusSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /**
   * Synchronously unlocks iOS speechSynthesis & Web AudioContext inside the tap
   * handler of Quick look / Full detail buttons.
   */
  unlockOnUserTap({ speakCue }: { speakCue: boolean }): void {
    this.stop();
    this.deps.unlockAudioContext();
    if (speakCue) {
      const unlockCue = this.deps.unlockDeviceCue ?? createDefaultUnlockCue();
      unlockCue(strings.statusShortCue);
    }
  }

  speakJob(
    rawText: string,
    {
      deviceClass,
      voiceOrder,
      rate,
      kokoroVoiceId,
      kokoroAllowed = true,
    }: {
      deviceClass: DeviceClass;
      voiceOrder: VoiceOrderPreference;
      rate: number;
      kokoroVoiceId: string;
      kokoroAllowed?: boolean;
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

    const order = resolveVoiceOrder(deviceClass, voiceOrder);
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

    // Lock one voice per job: once a provider starts playing, never switch mid-job.
    let started = false;
    let index = 0;

    const tryNext = (): VoiceProviderId | null => {
      if (jobId !== this.activeJobId || index >= readyChain.length) {
        if (jobId === this.activeJobId) {
          this.activeHandle = null;
          this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
        }
        return null;
      }

      const provider = readyChain[index++];
      this.updateSnapshot({
        speaking: true,
        paused: false,
        activeProvider: provider.id,
      });

      try {
        this.activeHandle = provider.speak(cleaned, {
          rate,
          voice: kokoroVoiceId,
          onStart: () => {
            if (jobId !== this.activeJobId) return;
            started = true;
            this.updateSnapshot({
              speaking: true,
              paused: false,
              activeProvider: provider.id,
            });
          },
          onEnd: () => {
            if (jobId !== this.activeJobId) return;
            this.activeHandle = null;
            this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
          },
          onError: () => {
            if (jobId !== this.activeJobId) return;
            this.activeHandle = null;
            if (!started && index < readyChain.length) {
              tryNext();
              return;
            }
            this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
          },
        });
        return provider.id;
      } catch {
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
    if (this.activeHandle) {
      this.activeHandle.stop();
      this.activeHandle = null;
    }
    if (this.snapshot.speaking || this.snapshot.paused || this.snapshot.activeProvider !== null) {
      this.updateSnapshot({ speaking: false, paused: false, activeProvider: null });
    }
  }
}
