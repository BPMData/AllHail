import { describe, expect, it, vi } from 'vitest';
import { SpeechCoordinator, type VoiceProvider } from './speechCoordinator.ts';

function fakeProvider(
  id: 'device' | 'kokoro',
  ready: boolean,
  options?: { failBeforeStart?: boolean },
): VoiceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    isReady: () => ready,
    speak: (text, callbacks) => {
      calls.push(text);
      if (options?.failBeforeStart) {
        queueMicrotask(() => callbacks.onError?.(new Error(`${id} failed`)));
      } else {
        callbacks.onStart?.(id);
      }
      return {
        pause: vi.fn(),
        resume: vi.fn(),
        stop: vi.fn(),
      };
    },
  };
}

describe('SpeechCoordinator', () => {
  it('uses device voice first on phones and kokoro first on laptops when ready', () => {
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

  it('falls back to the next provider if the first fails before starting, and keeps one voice per job', async () => {
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

  it('synchronously speaks cue and unlocks AudioContext inside tap handler', () => {
    const unlockAudioContext = vi.fn();
    const unlockDeviceCue = vi.fn();
    const coordinator = new SpeechCoordinator({
      deviceProvider: fakeProvider('device', true),
      kokoroProvider: fakeProvider('kokoro', false),
      unlockAudioContext,
      unlockDeviceCue,
    });

    coordinator.unlockOnUserTap({ speakCue: true });
    expect(unlockAudioContext).toHaveBeenCalledTimes(1);
    expect(unlockDeviceCue).toHaveBeenCalledWith('Describing');

    coordinator.unlockOnUserTap({ speakCue: false });
    expect(unlockAudioContext).toHaveBeenCalledTimes(2);
    expect(unlockDeviceCue).toHaveBeenCalledTimes(1);
  });
});
