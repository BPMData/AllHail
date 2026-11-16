import { isAudibleWaveform } from './chunkAudioPlayer.ts';

export type KokoroBackend = 'webgpu';

export type KokoroLoadProgress = {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
};

export type KokoroModelLike<TVoice extends string = 'af_heart'> = {
  generate: (
    text: string,
    options: { voice?: TVoice; speed?: number },
  ) => Promise<{ audio: Float32Array | ArrayLike<number>; sampling_rate?: number }>;
};

export type KokoroLoadResult<TModel extends KokoroModelLike = KokoroModelLike> = {
  instance: TModel;
  backend: KokoroBackend;
  sizeMb: number;
  tooSlow: boolean;
};

export const KOKORO_WEBGPU_SIZE_MB = 330;

export function hasAudiblePcm(samples: Float32Array | ArrayLike<number>): boolean {
  return isAudibleWaveform(samples);
}

export async function runKokoroCalibration<TModel extends KokoroModelLike>(
  instance: TModel,
  nowMs: () => number = () => performance.now(),
): Promise<{ audible: boolean; tooSlow: boolean }> {
  try {
    // Pass 1: warm up GPU shaders and throw away timing.
    await instance.generate('Warm up.', { voice: 'af_heart', speed: 1 });

    // Pass 2: time calibration sentence against real-time audio duration.
    const startedAt = nowMs();
    const calibration = await instance.generate(
      'AllHail helps students listen clearly.',
      { voice: 'af_heart', speed: 1 },
    );
    const generationMs = nowMs() - startedAt;
    const sampleRate = calibration.sampling_rate || 24000;
    const audioMs = (calibration.audio.length / sampleRate) * 1000;

    if (!hasAudiblePcm(calibration.audio) || audioMs <= 0) {
      return { audible: false, tooSlow: true };
    }
    return { audible: true, tooSlow: generationMs > audioMs };
  } catch {
    return { audible: false, tooSlow: true };
  }
}

export type LoadKokoroDeps<TModel extends KokoroModelLike> = {
  hasWebGpuAdapter: () => Promise<boolean>;
  loadModel: (opts: {
    dtype: 'fp32';
    device: 'webgpu';
    progress_callback: (event: KokoroLoadProgress) => void;
  }) => Promise<TModel>;
  onStageStart: (info: { backend: KokoroBackend; sizeMb: number }) => void;
  onProgress: (event: KokoroLoadProgress, info: { backend: KokoroBackend; sizeMb: number }) => void;
  nowMs?: () => number;
};

/**
 * Loads Kokoro strictly on WebGPU fp32 (~330 MB). There is no WASM/q8 fallback:
 * if WebGPU is unavailable, fails, produces silent PCM, or calibrates slower than
 * real time, Piper replaces it instead.
 */
export async function loadKokoroWebGpu<TModel extends KokoroModelLike>(
  deps: LoadKokoroDeps<TModel>,
): Promise<KokoroLoadResult<TModel>> {
  const nowMs = deps.nowMs ?? (() => performance.now());
  const canUseWebGpu = await deps.hasWebGpuAdapter().catch(() => false);
  if (!canUseWebGpu) {
    throw new Error('WebGPU adapter unavailable');
  }

  const info = { backend: 'webgpu' as const, sizeMb: KOKORO_WEBGPU_SIZE_MB };
  deps.onStageStart(info);

  const instance = await deps.loadModel({
    dtype: 'fp32',
    device: 'webgpu',
    progress_callback: (event) => deps.onProgress(event, info),
  });

  const cal = await runKokoroCalibration(instance, nowMs);
  if (!cal.audible) {
    throw new Error('Kokoro WebGPU produced silent or invalid PCM audio');
  }

  return {
    instance,
    backend: 'webgpu',
    sizeMb: KOKORO_WEBGPU_SIZE_MB,
    tooSlow: cal.tooSlow,
  };
}
