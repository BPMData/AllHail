import { describe, expect, it, vi } from 'vitest';
import type { KokoroState } from './kokoroClient.ts';
import {
  coordinateOfflineVoiceStartup,
  type KokoroDownloadTarget,
  type PiperDownloadTarget,
} from './offlineVoiceController.ts';
import type { PiperState } from './piperClient.ts';

function makeTargets(initialKokoro?: Partial<KokoroState>, initialPiper?: Partial<PiperState>) {
  let kState: KokoroState = {
    status: 'idle',
    progress: 0,
    tooSlow: false,
    startedAt: null,
    ...initialKokoro,
  };
  let pState: PiperState = {
    status: 'idle',
    progress: 0,
    tooSlow: false,
    startedAt: null,
    sizeMb: 93,
    ...initialPiper,
  };

  const kokoro: KokoroDownloadTarget = {
    getState: () => kState,
    startDownload: vi.fn(() => {
      kState = { ...kState, status: 'downloading' };
    }),
    markSkipped: vi.fn(() => {
      kState = { ...kState, status: 'skipped' };
    }),
  };

  const piper: PiperDownloadTarget = {
    getState: () => pState,
    startDownload: vi.fn(() => {
      pState = { ...pState, status: 'downloading' };
    }),
  };

  return {
    kokoro,
    piper,
    setKokoro: (patch: Partial<KokoroState>) => {
      kState = { ...kState, ...patch };
    },
  };
}

describe('coordinateOfflineVoiceStartup (pre-download WebGPU probe)', () => {
  it('skips Kokoro completely and starts Piper when laptop has no WebGPU adapter', async () => {
    const { kokoro, piper } = makeTargets();

    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'laptop',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => false,
      kokoro,
      piper,
    });

    expect(kokoro.startDownload).not.toHaveBeenCalled();
    expect(kokoro.markSkipped).toHaveBeenCalledTimes(1);
    expect(piper.startDownload).toHaveBeenCalledTimes(1);
  });

  it('downloads Kokoro first when WebGPU adapter exists, then starts Piper if Kokoro calibrates too slow or errors', async () => {
    const { kokoro, piper, setKokoro } = makeTargets();

    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'laptop',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => true,
      kokoro,
      piper,
    });

    expect(kokoro.startDownload).toHaveBeenCalledTimes(1);
    expect(piper.startDownload).not.toHaveBeenCalled();

    // Kokoro finishes calibration as tooSlow: true -> Piper automatically starts downloading
    setKokoro({ status: 'ready', progress: 100, tooSlow: true });
    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'laptop',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => true,
      kokoro,
      piper,
    });
    expect(piper.startDownload).toHaveBeenCalledTimes(1);

    // Same when Kokoro errors instead
    const errCase = makeTargets();
    errCase.setKokoro({ status: 'error' });
    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'laptop',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => true,
      kokoro: errCase.kokoro,
      piper: errCase.piper,
    });
    expect(errCase.piper.startDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps both Kokoro and Piper opt-in on phones until explicitly enabled', async () => {
    const { kokoro, piper } = makeTargets();

    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'phone',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => true,
      kokoro,
      piper,
    });
    expect(kokoro.startDownload).not.toHaveBeenCalled();
    expect(piper.startDownload).not.toHaveBeenCalled();

    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'phone',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: true,
      hasWebGpuAdapter: async () => true,
      kokoro,
      piper,
    });
    expect(kokoro.startDownload).not.toHaveBeenCalled();
    expect(piper.startDownload).toHaveBeenCalledTimes(1);
  });

  it('starts Piper immediately on laptops when voiceOrder is set to piper-first even with WebGPU', async () => {
    const { kokoro, piper } = makeTargets();

    await coordinateOfflineVoiceStartup({
      online: true,
      deviceClass: 'laptop',
      voiceOrder: 'piper-first',
      kokoroEnabledOnPhone: false,
      piperEnabledOnPhone: false,
      hasWebGpuAdapter: async () => true,
      kokoro,
      piper,
    });

    expect(piper.startDownload).toHaveBeenCalledTimes(1);
    expect(kokoro.startDownload).not.toHaveBeenCalled();
  });
});
