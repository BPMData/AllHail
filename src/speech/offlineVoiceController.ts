import type { DeviceClass } from '../settings.ts';
import type { KokoroState } from './kokoroClient.ts';
import type { PiperState } from './piperClient.ts';

export type OfflineVoiceDownloadTarget<TState> = {
  getState: () => TState;
  startDownload: () => void;
};

export type KokoroDownloadTarget = OfflineVoiceDownloadTarget<KokoroState> & {
  markSkipped: () => void;
};

export type PiperDownloadTarget = OfflineVoiceDownloadTarget<PiperState>;

export async function probeWebGpuAdapter(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * Decides Kokoro vs Piper BEFORE downloading anything on laptops:
 * - No WebGPU adapter -> skip Kokoro completely (~330 MB saved) and start Piper.
 * - Adapter present -> download Kokoro (webgpu/fp32). If Kokoro fails or calibrates
 *   too slow, automatically start Piper.
 * On phones, both voices remain opt-in from Settings.
 */
export async function coordinateOfflineVoiceStartup({
  online,
  deviceClass,
  kokoroEnabledOnPhone,
  piperEnabledOnPhone,
  hasWebGpuAdapter = probeWebGpuAdapter,
  kokoro,
  piper,
}: {
  online: boolean;
  deviceClass: DeviceClass;
  kokoroEnabledOnPhone: boolean;
  piperEnabledOnPhone: boolean;
  hasWebGpuAdapter?: () => Promise<boolean>;
  kokoro: KokoroDownloadTarget;
  piper: PiperDownloadTarget;
}): Promise<void> {
  if (!online) return;

  if (deviceClass === 'phone') {
    if (kokoroEnabledOnPhone && kokoro.getState().status === 'idle') {
      kokoro.startDownload();
    }
    if (piperEnabledOnPhone && piper.getState().status === 'idle') {
      piper.startDownload();
    }
    return;
  }

  // Laptop startup path
  const kokoroStatus = kokoro.getState().status;
  if (kokoroStatus === 'idle') {
    const hasGpu = await hasWebGpuAdapter().catch(() => false);
    // Guard against races while awaiting the async GPU probe.
    if (kokoro.getState().status === 'idle') {
      if (hasGpu) {
        kokoro.startDownload();
        return;
      }
      kokoro.markSkipped();
    }
  }

  const latestKokoro = kokoro.getState();
  const kokoroUnusable =
    latestKokoro.status === 'skipped' ||
    latestKokoro.status === 'error' ||
    (latestKokoro.status === 'ready' && latestKokoro.tooSlow);

  if (kokoroUnusable && piper.getState().status === 'idle') {
    piper.startDownload();
  }
}
