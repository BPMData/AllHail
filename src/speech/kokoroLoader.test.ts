import { describe, expect, it, vi } from 'vitest';
import {
  hasAudiblePcm,
  KOKORO_WEBGPU_SIZE_MB,
  loadKokoroWebGpu,
  type KokoroModelLike,
} from './kokoroLoader.ts';

function makeAudio(lengthSamples: number, amplitude = 0.25, sampleRate = 24000) {
  const audio = new Float32Array(lengthSamples);
  if (amplitude !== 0) {
    for (let i = 0; i < audio.length; i += 1) {
      audio[i] = i % 2 === 0 ? amplitude : -amplitude;
    }
  }
  return { audio, sampling_rate: sampleRate };
}

describe('hasAudiblePcm', () => {
  it('returns false for empty, silent, or non-finite buffers and true for audible audio', () => {
    expect(hasAudiblePcm(new Float32Array(0))).toBe(false);
    expect(hasAudiblePcm(new Float32Array(100))).toBe(false);
    expect(hasAudiblePcm(new Float32Array([0, Number.NaN, 0.2]))).toBe(false);
    expect(hasAudiblePcm(new Float32Array([0, 0.05, -0.05]))).toBe(true);
  });
});

describe('loadKokoroWebGpu (WebGPU fp32 only, no WASM fallback)', () => {
  it('loads WebGPU fp32 (~330 MB), discards warm-up timing, and returns fast calibration result', async () => {
    let clockMs = 0;
    const stages: Array<{ backend: string; sizeMb: number }> = [];
    const loadCalls: Array<{ dtype: string; device: string }> = [];

    const webgpuModel: KokoroModelLike = {
      generate: vi
        .fn()
        // Pass 1: slow warm-up (5000 ms) must be discarded
        .mockImplementationOnce(async () => {
          clockMs += 5000;
          return makeAudio(24000, 0.2); // 1000 ms audio
        })
        // Pass 2: fast calibration (400 ms to generate 1000 ms audio => 2.5x real time)
        .mockImplementationOnce(async () => {
          clockMs += 400;
          return makeAudio(24000, 0.2);
        }),
    };

    const result = await loadKokoroWebGpu({
      hasWebGpuAdapter: async () => true,
      loadModel: async (opts) => {
        loadCalls.push({ dtype: opts.dtype, device: opts.device });
        opts.progress_callback({ status: 'progress', file: 'model.onnx', loaded: 50, total: 100 });
        return webgpuModel;
      },
      onStageStart: (info) => stages.push(info),
      onProgress: vi.fn(),
      nowMs: () => clockMs,
    });

    expect(loadCalls).toEqual([{ dtype: 'fp32', device: 'webgpu' }]);
    expect(stages).toEqual([{ backend: 'webgpu', sizeMb: KOKORO_WEBGPU_SIZE_MB }]);
    expect(result.backend).toBe('webgpu');
    expect(result.sizeMb).toBe(330);
    expect(result.tooSlow).toBe(false);
    expect(webgpuModel.generate).toHaveBeenCalledTimes(2);
  });

  it('rejects immediately without calling loadModel or any wasm/q8 fallback when no WebGPU adapter exists', async () => {
    const loadModel = vi.fn();
    const onStageStart = vi.fn();

    await expect(
      loadKokoroWebGpu({
        hasWebGpuAdapter: async () => false,
        loadModel,
        onStageStart,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow(/WebGPU adapter unavailable/);

    expect(loadModel).not.toHaveBeenCalled();
    expect(onStageStart).not.toHaveBeenCalled();
  });

  it('rejects silent WebGPU output without falling back to WASM q8 and flags slow WebGPU devices cleanly', async () => {
    const silentWebGpu: KokoroModelLike = {
      generate: vi.fn(async () => makeAudio(24000, 0)),
    };
    const loadSilent = vi.fn(async () => silentWebGpu);

    await expect(
      loadKokoroWebGpu({
        hasWebGpuAdapter: async () => true,
        loadModel: loadSilent,
        onStageStart: vi.fn(),
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow(/silent or invalid PCM/);
    expect(loadSilent).toHaveBeenCalledTimes(1);

    let clockMs = 0;
    const slowWebGpu: KokoroModelLike = {
      generate: vi
        .fn()
        .mockImplementationOnce(async () => {
          clockMs += 3000;
          return makeAudio(24000, 0.2);
        })
        .mockImplementationOnce(async () => {
          clockMs += 1500; // slower than 1000 ms audio
          return makeAudio(24000, 0.2);
        }),
    };

    const slowResult = await loadKokoroWebGpu({
      hasWebGpuAdapter: async () => true,
      loadModel: async () => slowWebGpu,
      onStageStart: vi.fn(),
      onProgress: vi.fn(),
      nowMs: () => clockMs,
    });
    expect(slowResult.backend).toBe('webgpu');
    expect(slowResult.tooSlow).toBe(true);
  });
});
