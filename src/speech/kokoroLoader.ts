export type KokoroBackend = 'webgpu' | 'wasm';

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

export function hasAudiblePcm(samples: Float32Array | ArrayLike<number>): boolean {
  if (!samples || samples.length === 0) return false;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    if (!Number.isFinite(v)) return false;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  return peak > 1e-5;
}

export async function runKokoroCalibration<TModel extends KokoroModelLike>(
  instance: TModel,
  nowMs: () => number = () => performance.now(),
): Promise<{ audible: boolean; tooSlow: boolean }> {
  try {
    // Pass 1: warm up GPU shaders / WASM allocations and throw away timing.
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
    dtype: 'fp32' | 'q8';
    device: KokoroBackend;
    progress_callback: (event: KokoroLoadProgress) => void;
  }) => Promise<TModel>;
  onStageStart: (info: { backend: KokoroBackend; sizeMb: number }) => void;
  onProgress: (event: KokoroLoadProgress, info: { backend: KokoroBackend; sizeMb: number }) => void;
  nowMs?: () => number;
};

/**
 * Tries WebGPU fp32 first (~330 MB) whenever a WebGPU adapter exists so capable laptops get
 * ~2x real-time speech. Falls back to WASM q8 (~90 MB) only if WebGPU fails or produces
 * silent/invalid audio, and runs the warmed-up calibration check to flag slow CPUs.
 */
export async function loadKokoroWithFallback<TModel extends KokoroModelLike>(
  deps: LoadKokoroDeps<TModel>,
): Promise<KokoroLoadResult<TModel>> {
  const nowMs = deps.nowMs ?? (() => performance.now());
  const canTryWebGpu = await deps.hasWebGpuAdapter().catch(() => false);

  if (canTryWebGpu) {
    const webgpuInfo = { backend: 'webgpu' as const, sizeMb: 330 };
    deps.onStageStart(webgpuInfo);
    try {
      const instance = await deps.loadModel({
        dtype: 'fp32',
        device: 'webgpu',
        progress_callback: (event) => deps.onProgress(event, webgpuInfo),
      });
      const cal = await runKokoroCalibration(instance, nowMs);
      if (cal.audible) {
        return {
          instance,
          backend: 'webgpu',
          sizeMb: 330,
          tooSlow: cal.tooSlow,
        };
      }
    } catch {
      // Fall through cleanly to WASM q8.
    }
  }

  const wasmInfo = { backend: 'wasm' as const, sizeMb: 90 };
  deps.onStageStart(wasmInfo);
  const wasmInstance = await deps.loadModel({
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (event) => deps.onProgress(event, wasmInfo),
  });
  const wasmCal = await runKokoroCalibration(wasmInstance, nowMs);
  return {
    instance: wasmInstance,
    backend: 'wasm',
    sizeMb: 90,
    tooSlow: !wasmCal.audible || wasmCal.tooSlow,
  };
}
