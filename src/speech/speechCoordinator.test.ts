import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAllowedEnglishDeviceVoices,
  getDeviceVoiceShortName,
  resolveDeviceVoice,
  selectBestDeviceVoice,
  SpeechCoordinator,
  type VoiceProvider,
} from './speechCoordinator.ts';

function fakeProvider(
  id: 'device' | 'kokoro',
  ready: boolean,
  options?: { failBeforeStart?: boolean; stallStart?: boolean },
): VoiceProvider & { calls: string[]; stopSpies: ReturnType<typeof vi.fn>[] } {
  const calls: string[] = [];
  const stopSpies: ReturnType<typeof vi.fn>[] = [];
  return {
    id,
    calls,
    stopSpies,
    isReady: () => ready,
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
});

describe('SpeechCoordinator', () => {
  it('uses device voice first on phones and kokoro first on laptops when ready and fast', () => {
    const device = fakeProvider('device', true);
    const kokoro = fakeProvider('kokoro', true);
    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoro,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
    });

    const phoneChoice = coordinator.speakJob('1/2 cup', {
      deviceClass: 'phone',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
    });
    expect(phoneChoice).toBe('device');
    expect(device.calls).toEqual(['one half cup']);

    const laptopChoice = coordinator.speakJob('3/4 mile', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
    });
    expect(laptopChoice).toBe('kokoro');
    expect(kokoro.calls).toEqual(['three quarters mile']);
  });

  it('uses device voice first on laptops when Kokoro is marked too slow', () => {
    const device = fakeProvider('device', true);
    const kokoro = fakeProvider('kokoro', true);
    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: kokoro,
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
    });
    expect(choice).toBe('device');
    expect(kokoro.calls).toHaveLength(0);
  });

  it('falls back to device voice if Kokoro has not started playing within 4 seconds', () => {
    vi.useFakeTimers();
    const stalledKokoro = fakeProvider('kokoro', true, { stallStart: true });
    const device = fakeProvider('device', true);
    const onProviderStarted = vi.fn();

    const coordinator = new SpeechCoordinator({
      deviceProvider: device,
      kokoroProvider: stalledKokoro,
      unlockAudioContext: vi.fn(),
      unlockDeviceCue: vi.fn(),
      firstAudioTimeoutMs: 4000,
    });

    coordinator.speakJob('A clear description.', {
      deviceClass: 'laptop',
      voiceOrder: 'auto',
      rate: 1,
      kokoroVoiceId: 'af_heart',
      kokoroAllowed: true,
      onProviderStarted,
    });

    expect(stalledKokoro.calls).toEqual(['A clear description.']);
    expect(device.calls).toHaveLength(0);

    // At 3.9s still waiting on Kokoro
    vi.advanceTimersByTime(3999);
    expect(device.calls).toHaveLength(0);

    // At 4.0s Kokoro is cancelled and device voice takes over seamlessly
    vi.advanceTimersByTime(1);
    expect(stalledKokoro.stopSpies[0]).toHaveBeenCalledTimes(1);
    expect(device.calls).toEqual(['A clear description.']);
    expect(coordinator.getStatus().activeProvider).toBe('device');
    expect(onProviderStarted).toHaveBeenCalledWith('device');
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

  it('follows exact tier priority a -> b -> c -> d -> e -> f -> g', () => {
    // g. System default over generic English, then first English
    const tierG = [
      makeVoice('Alex', 'en-US', false),
      makeVoice('Custom Default', 'en-GB', true),
    ];
    expect(selectBestDeviceVoice(tierG)?.name).toBe('Custom Default');

    // f. Eloquence tier beats system default, ordered Reed -> ... -> Grandpa
    const tierF = [
      ...tierG,
      makeVoice('Grandpa (English (US))', 'en-US'),
      makeVoice('Sandy (English (US))', 'en-US'),
      makeVoice('Reed (English (US))', 'en-US'),
    ];
    expect(selectBestDeviceVoice(tierF)?.name).toBe('Reed (English (US))');

    // e. Samantha, Ava, Daniel, Karen, Moira, Tessa, Rishi beat Eloquence
    const tierE = [...tierF, makeVoice('Moira', 'en-IE'), makeVoice('Samantha', 'en-US')];
    expect(selectBestDeviceVoice(tierE)?.name).toBe('Samantha');

    // d. Google US English beats Google UK English Female and tier e when online
    const tierD = [
      ...tierE,
      makeVoice('Google UK English Female', 'en-GB'),
      makeVoice('Google US English', 'en-US'),
    ];
    expect(selectBestDeviceVoice(tierD, { online: true })?.name).toBe('Google US English');

    // c. Natural beats Google
    const tierC = [
      ...tierD,
      makeVoice('Microsoft Ava Online (Natural) - English (United States)', 'en-US'),
    ];
    expect(selectBestDeviceVoice(tierC, { online: true })?.name).toBe(
      'Microsoft Ava Online (Natural) - English (United States)',
    );

    // b. Other Premium or Enhanced beats Natural
    const tierB = [...tierC, makeVoice('Ava (Premium)', 'en-US')];
    expect(selectBestDeviceVoice(tierB, { online: true })?.name).toBe('Ava (Premium)');

    // a. "Allison (Enhanced)" wins above all other Premium/Enhanced
    const tierA = [...tierB, makeVoice('Allison (Enhanced)', 'en-US')];
    expect(selectBestDeviceVoice(tierA, { online: true })?.name).toBe('Allison (Enhanced)');
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

    // Online picks Microsoft Natural first
    expect(selectBestDeviceVoice(voices, { online: true })?.name).toBe(
      'Microsoft Ava Online (Natural) - English (United States)',
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
