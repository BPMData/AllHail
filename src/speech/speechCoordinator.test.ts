import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserDeviceVoiceProvider,
  getAllowedEnglishDeviceVoices,
  getDeviceVoiceShortName,
  resolveDeviceVoice,
  selectBestDeviceVoice,
  SpeechCoordinator,
  VOICES_WAIT_TIMEOUT_MS,
  type VoiceProvider,
} from './speechCoordinator.ts';

function fakeProvider(
  id: 'device' | 'kokoro' | 'piper',
  ready: boolean,
  options?: { failBeforeStart?: boolean; stallStart?: boolean; busy?: boolean },
): VoiceProvider & { calls: string[]; stopSpies: ReturnType<typeof vi.fn>[] } {
  const calls: string[] = [];
  const stopSpies: ReturnType<typeof vi.fn>[] = [];
  return {
    id,
    calls,
    stopSpies,
    isReady: () => ready,
    isBusy: () => Boolean(options?.busy),
    speak: (text, callbacks) => {
      calls.push(text);
      const stop = vi.fn();
      stopSpies.push(stop);
      if (options?.failBeforeStart) {
        queueMicrotask(() => callbacks.onError?.(new Error(`${id} failed`)));
      } else if (!options?.stallStart) {
        callbacks.onStart?.(id);
      }
      return {
        pause: vi.fn(),
        resume: vi.fn(),
        stop,
      };
    },
  };
}

function makeVoice(name: string, lang: string, isDefault = false): SpeechSynthesisVoice {
  return {
    name,
    lang,
    default: isDefault,
    localService: true,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SpeechCoordinator', () => {
  it('uses device voice first on phones and kokoro -> piper -> device on laptops', () => {
    const device = fakeProvider('device', true);
    const kokoro = fakeProvider('kokoro', true);
    const piper = fakeProvider('piper', true);
    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoro,
      piperProvider: piper,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    const phoneChoice = coordinator.speakJob('1/2 cup', {
      deviceClass: 'phone',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      piperAllowed: true,
    });
    expect(phoneChoice).toBe('device');
    expect(device.calls).toEqual(['one half cup']);

    const laptopChoice = coordinator.speakJob('3/4 mile', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      piperAllowed: true,
    });
    expect(laptopChoice).toBe('kokoro');
    expect(kokoro.calls).toEqual(['three quarters mile']);
  });

  it('uses Piper automatically on laptops when Kokoro is too slow or not ready', () => {
    const device = fakeProvider('device', true);
    const kokoro = fakeProvider('kokoro', true);
    const piper = fakeProvider('piper', true);
    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoro,
      piperProvider: piper,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    const choice = coordinator.speakJob('Hello class', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      kokoroTooSlow: true,
      piperAllowed: true,
      piperTooSlow: false,
    });
    expect(choice).toBe('piper');
    expect(kokoro.calls).toHaveLength(0);
    expect(piper.calls).toEqual(['Hello class']);
  });

  it('jumps straight to device voice at 4 s if Kokoro times out while Piper is unready or busy (<5 s silence cap)', () => {
    vi.useFakeTimers();
    const stalledKokoro = fakeProvider('kokoro', true, { stallStart: true });
    const unreadyPiper = fakeProvider('piper', false);
    const device = fakeProvider('device', true);
    const onProviderStarted = vi.fn();

    const coordinator1 = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: stalledKokoro,
      piperProvider: unreadyPiper,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
      firstAudioTimeoutMs: 4000,
    });

    coordinator1.speakJob('A clear description.', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      piperAllowed: true,
      onProviderStarted,
    });

    expect(stalledKokoro.calls).toEqual(['A clear description.']);
    expect(device.calls).toHaveLength(0);

    // At 3.999 s still waiting on Kokoro
    vi.advanceTimersByTime(3999);
    expect(device.calls).toHaveLength(0);

    // At 4.000 s Kokoro is cancelled and device voice starts immediately
    vi.advanceTimersByTime(1);
    expect(stalledKokoro.stopSpies[0]).toHaveBeenCalledTimes(1);
    expect(unreadyPiper.calls).toHaveLength(0);
    expect(device.calls).toEqual(['A clear description.']);
    expect(coordinator1.getStatus().activeProvider).toBe('device');
    expect(onProviderStarted).toHaveBeenCalledWith('device');

    // Also skips busy Piper directly to device voice when timeout hits
    const busyPiper = fakeProvider('piper', true, { busy: true });
    const device2 = fakeProvider('device', true);
    const stalledKokoro2 = fakeProvider('kokoro', true, { stallStart: true });
    const coordinator2 = new SpeechCoordinator({
      deviceProvider: device2,
      kokoroProvider: stalledKokoro2,
      piperProvider: busyPiper,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
      firstAudioTimeoutMs: 4000,
    });

    coordinator2.speakJob('Busy piper check.', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      piperAllowed: true,
    });
    vi.advanceTimersByTime(4000);
    expect(busyPiper.calls).toHaveLength(0);
    expect(device2.calls).toEqual(['Busy piper check.']);
  });

  it('uses idle calibrated Piper after Kokoro 4s timeout without arming a second 4s watchdog', () => {
    vi.useFakeTimers();
    const stalledKokoro = fakeProvider('kokoro', true, { stallStart: true });
    const idleStalledPiper = fakeProvider('piper', true, { stallStart: true, busy: false });
    const device = fakeProvider('device', true);

    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: stalledKokoro,
      piperProvider: idleStalledPiper,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
      firstAudioTimeoutMs: 4000,
    });

    coordinator.speakJob('Timeout handoff.', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      piperAllowed: true,
    });

    vi.advanceTimersByTime(4000);
    expect(idleStalledPiper.calls).toEqual(['Timeout handoff.']);
    // No second 4-second watchdog timer is armed for Piper.
    vi.advanceTimersByTime(8000);
    expect(idleStalledPiper.stopSpies[0]).not.toHaveBeenCalled();
  });

  it('skips Kokoro immediately without blocking while downloading or when disallowed on phone', () => {
    const device = fakeProvider('device', true);
    const kokoroDownloading = fakeProvider('kokoro', false);
    const coordinator1 = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoroDownloading,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    const laptopFallback = coordinator1.speakJob('Hello', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
    });
    expect(laptopFallback).toBe('device');
    expect(kokoroDownloading.calls).toHaveLength(0);

    const kokoroReady = fakeProvider('kokoro', true);
    const coordinator2 = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoroReady,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    const phoneDisallowed = coordinator2.speakJob('Hello', {
      deviceClass: 'phone',
      voiceOrder: 'kokoro-first',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: false,
    });
    expect(phoneDisallowed).toBe('device');
    expect(kokoroReady.calls).toHaveLength(0);
  });

  it('falls back to the next provider if the first fails before starting', async () => {
    const kokoroBroken = fakeProvider('kokoro', true, { failBeforeStart: true });
    const device = fakeProvider('device', true);
    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoroBroken,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    coordinator.speakJob('Test photo', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
    });

    await Promise.resolve();
    expect(kokoroBroken.calls).toEqual(['Test photo']);
    expect(device.calls).toEqual(['Test photo']);
    expect(coordinator.getStatus().activeProvider).toBe('device');
  });

  it('only speaks Describing on capture unlock (forwarding deviceVoiceName and online) and never on playback-only unlock', () => {
    const unlockAudioContext = vi.fn();
    const unlockDeviceCue = vi.fn();
    const coordinator = new SpeechCoordinator({
      deviceProvider: fakeProvider('device', true),
      kokoroProvider: fakeProvider('kokoro', false),
      unlockAudioContext,
      unlockDeviceCue,
    });

    coordinator.unlockOnCaptureTap({
      speakCue: true,
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });
    expect(unlockAudioContext).toHaveBeenCalledTimes(1);
    expect(unlockDeviceCue).toHaveBeenCalledWith('Describing', {
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });

    coordinator.unlockAudioOnly();
    expect(unlockAudioContext).toHaveBeenCalledTimes(2);
    expect(unlockDeviceCue).toHaveBeenCalledTimes(1);
  });
});

describe('device voice automatic order, novelty filter, offline skipping, and preference resolution', () => {
  it('excludes all 19 novelty voices and non-English voices from automatic selection and the picker', () => {
    const noveltyNames = [
      'Albert',
      'Bad News',
      'Bahh',
      'Bells',
      'Boing',
      'Bubbles',
      'Cellos',
      'Fred',
      'Good News',
      'Jester',
      'Junior',
      'Kathy',
      'Organ',
      'Ralph',
      'Superstar',
      'Trinoids',
      'Whisper',
      'Wobble',
      'Zarvox',
    ];
    const noveltyList = [
      ...noveltyNames.map((n, idx) => makeVoice(n, 'en-US', idx === 0)),
      makeVoice('Junior (English (US))', 'en-US'),
      makeVoice('Thomas', 'fr-FR', true),
    ];

    expect(getAllowedEnglishDeviceVoices(noveltyList)).toEqual([]);
    expect(selectBestDeviceVoice(noveltyList)).toBeNull();
  });

  it('follows v3 priority: Google UK Female -> Google US -> Natural -> Allison (Enhanced) -> Premium/Enhanced -> Samantha..Rishi -> Eloquence -> default', () => {
    // System default over generic English, then first English
    const tierDefault = [
      makeVoice('Alex', 'en-US', false),
      makeVoice('Custom Default', 'en-GB', true),
    ];
    expect(selectBestDeviceVoice(tierDefault)?.name).toBe('Custom Default');

    // Eloquence tier beats system default, ordered Reed -> ... -> Grandpa
    const tierEloquence = [
      ...tierDefault,
      makeVoice('Grandpa (English (US))', 'en-US'),
      makeVoice('Sandy (English (US))', 'en-US'),
      makeVoice('Reed (English (US))', 'en-US'),
    ];
    expect(selectBestDeviceVoice(tierEloquence)?.name).toBe('Reed (English (US))');

    // Samantha, Ava, Daniel, Karen, Moira, Tessa, Rishi beat Eloquence
    const tierCurated = [...tierEloquence, makeVoice('Moira', 'en-IE'), makeVoice('Samantha', 'en-US')];
    expect(selectBestDeviceVoice(tierCurated)?.name).toBe('Samantha');

    // Other Premium or Enhanced beats curated Apple voices
    const tierPremium = [...tierCurated, makeVoice('Ava (Premium)', 'en-US')];
    expect(selectBestDeviceVoice(tierPremium, { online: true })?.name).toBe('Ava (Premium)');

    // "Allison (Enhanced)" beats other Premium/Enhanced
    const tierAllison = [...tierPremium, makeVoice('Allison (Enhanced)', 'en-US')];
    expect(selectBestDeviceVoice(tierAllison, { online: true })?.name).toBe('Allison (Enhanced)');

    // Edge "Natural" voices beat Allison (Enhanced)
    const tierNatural = [
      ...tierAllison,
      makeVoice('Microsoft Ava Online (Natural) - English (United States)', 'en-US'),
    ];
    expect(selectBestDeviceVoice(tierNatural, { online: true })?.name).toBe(
      'Microsoft Ava Online (Natural) - English (United States)',
    );

    // Google US English beats Edge Natural when online
    const tierGoogleUs = [...tierNatural, makeVoice('Google US English', 'en-US')];
    expect(selectBestDeviceVoice(tierGoogleUs, { online: true })?.name).toBe('Google US English');

    // Google UK English Female sits at #1 overall when online
    const tierGoogleUk = [...tierGoogleUs, makeVoice('Google UK English Female', 'en-GB')];
    expect(selectBestDeviceVoice(tierGoogleUk, { online: true })?.name).toBe(
      'Google UK English Female',
    );
  });

  it('skips Online and Google voices when offline and falls back quietly if saved preference is unavailable', () => {
    const voices = [
      makeVoice('Kathy', 'en-US', true),
      makeVoice('Microsoft Ava Online (Natural) - English (United States)', 'en-US'),
      makeVoice('Google US English', 'en-US'),
      makeVoice('Google UK English Female', 'en-GB'),
      makeVoice('Daniel', 'en-GB'),
      makeVoice('Reed', 'en-US'),
    ];

    // Online picks Google UK English Female first
    expect(selectBestDeviceVoice(voices, { online: true })?.name).toBe(
      'Google UK English Female',
    );

    // Offline skips Online and Google voices -> picks Daniel
    expect(selectBestDeviceVoice(voices, { online: false })?.name).toBe('Daniel');

    // Saved Google voice works online, marks missing & falls back to Daniel offline
    expect(resolveDeviceVoice(voices, { preferredVoiceName: 'Google US English', online: true })).toEqual({
      voice: voices[2],
      preferredMissing: false,
    });
    expect(resolveDeviceVoice(voices, { preferredVoiceName: 'Google US English', online: false })).toEqual({
      voice: voices[4],
      preferredMissing: true,
    });

    // Deleted/other-computer voice marks missing and falls back to automatic
    expect(resolveDeviceVoice(voices, { preferredVoiceName: 'Allison (Enhanced)', online: false })).toEqual({
      voice: voices[4],
      preferredMissing: true,
    });
  });

  it('extracts clean short names for preview greetings', () => {
    expect(getDeviceVoiceShortName('Allison (Enhanced)')).toBe('Allison');
    expect(getDeviceVoiceShortName('Microsoft Ava Online (Natural) - English (United States)')).toBe('Ava');
    expect(getDeviceVoiceShortName('Reed (English (US))')).toBe('Reed');
    expect(getDeviceVoiceShortName('Samantha')).toBe('Samantha');
    expect(getDeviceVoiceShortName('Google US English')).toBe('Google US English');
  });
});

describe('createBrowserDeviceVoiceProvider single-utterance & voiceschanged wait', () => {
  function setupMockSpeechSynthesis(initialVoices: SpeechSynthesisVoice[]) {
    let voices = initialVoices;
    const spoken: Array<{ text: string; voice: SpeechSynthesisVoice | null; rate: number }> = [];
    const listeners = new Map<string, Set<() => void>>();

    class FakeUtterance {
      text: string;
      lang = 'en';
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    const pauseSpy = vi.fn();
    const resumeSpy = vi.fn();
    const cancelSpy = vi.fn();
    const getVoicesSpy = vi.fn(() => voices);

    const mockSynth = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: getVoicesSpy,
      speak: vi.fn((utt: FakeUtterance) => {
        spoken.push({ text: utt.text, voice: utt.voice, rate: utt.rate });
        utt.onstart?.();
      }),
      cancel: cancelSpy,
      pause: pauseSpy,
      resume: resumeSpy,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      }),
      removeEventListener: vi.fn((event: string, cb: () => void) => {
        listeners.get(event)?.delete(cb);
      }),
    };

    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: mockSynth,
    });

    return {
      spoken,
      mockSynth,
      getVoicesSpy,
      pauseSpy,
      resumeSpy,
      setVoicesAndNotify(nextVoices: SpeechSynthesisVoice[]) {
        voices = nextVoices;
        for (const cb of [...(listeners.get('voiceschanged') ?? [])]) {
          cb();
        }
      },
    };
  }

  it('sends the full description as ONE utterance with no sentence splits and no keepalive timer', () => {
    vi.useFakeTimers();
    const mock = setupMockSpeechSynthesis([
      makeVoice('Google UK English Female', 'en-GB'),
      makeVoice('Samantha', 'en-US'),
    ]);

    const provider = createBrowserDeviceVoiceProvider();
    expect(mock.getVoicesSpy).toHaveBeenCalledTimes(1); // Preloaded at startup

    const fullDescription =
      'A clean, modern app icon showing two stylized sailboats on wavy water, set against a deep teal background, with a calm and friendly nautical feel.';

    provider.speak(fullDescription, { rate: 1, online: true });

    expect(mock.spoken).toHaveLength(1);
    expect(mock.spoken[0].text).toBe(fullDescription);
    expect(mock.spoken[0].voice?.name).toBe('Google UK English Female');

    // Advancing timers long past 10-14 seconds must NEVER invoke pause/resume keepalive
    vi.advanceTimersByTime(30_000);
    expect(mock.pauseSpy).not.toHaveBeenCalled();
    expect(mock.resumeSpy).not.toHaveBeenCalled();
  });

  it('waits for voiceschanged when getVoices() starts empty before choosing Google UK English Female', async () => {
    const mock = setupMockSpeechSynthesis([]);
    const provider = createBrowserDeviceVoiceProvider();
    const onStart = vi.fn();

    provider.speak('Two sailboats on wavy water.', {
      rate: 1.1,
      online: true,
      onStart,
    });

    // Must wait rather than speaking immediately with null/default robotic voice
    expect(mock.spoken).toHaveLength(0);
    expect(onStart).not.toHaveBeenCalled();

    // Simulate Chrome populating voices and firing voiceschanged
    mock.setVoicesAndNotify([
      makeVoice('Albert', 'en-US', true),
      makeVoice('Samantha', 'en-US'),
      makeVoice('Google UK English Female', 'en-GB'),
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(mock.spoken).toHaveLength(1);
    expect(mock.spoken[0].text).toBe('Two sailboats on wavy water.');
    expect(mock.spoken[0].voice?.name).toBe('Google UK English Female');
    expect(onStart).toHaveBeenCalledWith('device');
  });

  it('falls back after 1.5s timeout if voiceschanged never arrives so speech does not hang', async () => {
    vi.useFakeTimers();
    const mock = setupMockSpeechSynthesis([]);
    const provider = createBrowserDeviceVoiceProvider();

    provider.speak('Fallback check.', { rate: 1, online: true });
    expect(mock.spoken).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(VOICES_WAIT_TIMEOUT_MS - 1);
    expect(mock.spoken).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(mock.spoken).toHaveLength(1);
    expect(mock.spoken[0].text).toBe('Fallback check.');
    expect(mock.spoken[0].voice).toBeNull();
  });
});
