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
    options: { voice?: TVoice; speed?: number }
  ) => Promise<{ audio: Float32Array | ArrayLike<number>; sampling_rate?: number }>;
};

export type KokoroLoadResult<TModel extends KokoroModelLike = KokoroModelLike> = {
  instance: TModel;
  backend: KokoroBackend;
  sizeMb: number;
  cached: boolean;
  tooSlow: boolean;
};

export const KOKORO_WEBGPU_SIZE_MB = 330;
export const KOKORO_TRANSFORMERS_CACHE_NAME = 'transformers-cache';
export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export async function isKokoroModelCached({
  cacheStorage = typeof caches !== 'undefined' ? caches : undefined,
  modelId = KOKORO_MODEL_ID,
}: {
  cacheStorage?: Pick<CacheStorage, 'open'> & { has?: (cacheName: string) => Promise<boolean> };
  modelId?: string;
} = {}): Promise<boolean> {
  if (!cacheStorage) return false;
  try {
    if (typeof cacheStorage.has === 'function') {
      const exists = await cacheStorage.has(KOKORO_TRANSFORMERS_CACHE_NAME);
      if (!exists) return false;
    }
    const cache = await cacheStorage.open(KOKORO_TRANSFORMERS_CACHE_NAME);
    const requests = await cache.keys();
    return requests.some((req) => req.url.includes(modelId) && /\.onnx(?:$|\?)/.test(req.url));
  } catch {
    return false;
  }
}

export function hasAudiblePcm(samples: Float32Array | ArrayLike<number>): boolean {
  return isAudibleWaveform(samples);
}

export async function runKokoroCalibration<TModel extends KokoroModelLike>(
  instance: TModel,
  nowMs: () => number = () => performance.now()
): Promise<{ audible: boolean; tooSlow: boolean }> {
  try {
    // Pass 1: warm up GPU shaders and throw away timing.
    await instance.generate('Warm up.', { voice: 'af_heart', speed: 1 });

    // Pass 2: time calibration sentence against real-time audio duration.
    const startedAt = nowMs();
    const calibration = await instance.generate('AllHail helps students listen clearly.', {
      voice: 'af_heart',
      speed: 1,
    });
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
  isCached?: () => Promise<boolean>;
  loadModel: (opts: {
    dtype: 'fp32';
    device: 'webgpu';
    progress_callback: (event: KokoroLoadProgress) => void;
  }) => Promise<TModel>;
  onStageStart: (info: { backend: KokoroBackend; sizeMb: number; cached: boolean }) => void;
  onProgress: (event: KokoroLoadProgress, info: { backend: KokoroBackend; sizeMb: number; cached: boolean }) => void;
  nowMs?: () => number;
};

/**
 * Loads Kokoro strictly on WebGPU fp32 (~330 MB). There is no WASM/q8 fallback:
 * if WebGPU is unavailable, fails, produces silent PCM, or calibrates slower than
 * real time, Piper replaces it instead.
 */
export async function loadKokoroWebGpu<TModel extends KokoroModelLike>(
  deps: LoadKokoroDeps<TModel>
): Promise<KokoroLoadResult<TModel>> {
  const nowMs = deps.nowMs ?? (() => performance.now());
  const canUseWebGpu = await deps.hasWebGpuAdapter().catch(() => false);
  if (!canUseWebGpu) {
    throw new Error('WebGPU adapter unavailable');
  }

  const cached = deps.isCached ? await deps.isCached().catch(() => false) : false;
  const info = { backend: 'webgpu' as const, sizeMb: KOKORO_WEBGPU_SIZE_MB, cached };
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
    cached,
    tooSlow: cal.tooSlow,
  };
}
