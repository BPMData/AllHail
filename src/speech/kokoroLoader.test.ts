import { describe, expect, it, vi } from 'vitest';
import {
  hasAudiblePcm,
  loadKokoroWithFallback,
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

describe('loadKokoroWithFallback', () => {
  it('prefers WebGPU fp32 (~330 MB) first, ignores slow warm-up timing, and stays fast', async () => {
    let clockMs = 0;
    const stages: Array<{ backend: string; sizeMb: number }> = [];
    const loadCalls: Array<{ dtype: string; device: string }> = [];

    const webgpuModel: KokoroModelLike = {
      generate: vi
        .fn()
        // Pass 1: slow warm-up (5000 ms) should be discarded
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

    const result = await loadKokoroWithFallback({
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
    expect(stages).toEqual([{ backend: 'webgpu', sizeMb: 330 }]);
    expect(result.backend).toBe('webgpu');
    expect(result.sizeMb).toBe(330);
    expect(result.tooSlow).toBe(false);
    expect(webgpuModel.generate).toHaveBeenCalledTimes(2);
  });

  it('falls back to WASM q8 (~90 MB) when WebGPU fp32 produces silent PCM and flags slow CPUs', async () => {
    let clockMs = 0;
    const stages: Array<{ backend: string; sizeMb: number }> = [];
    const loadCalls: Array<{ dtype: string; device: string }> = [];

    const silentWebGpu: KokoroModelLike = {
      generate: vi.fn(async () => makeAudio(24000, 0)), // all zeros
    };

    const slowWasm: KokoroModelLike = {
      generate: vi
        .fn()
        // Warm-up
        .mockImplementationOnce(async () => {
          clockMs += 4000;
          return makeAudio(24000, 0.2);
        })
        // Calibration: 2400 ms to produce 1000 ms of audio => slower than real time
        .mockImplementationOnce(async () => {
          clockMs += 2400;
          return makeAudio(24000, 0.2);
        }),
    };

    const result = await loadKokoroWithFallback({
      hasWebGpuAdapter: async () => true,
      loadModel: async (opts) => {
        loadCalls.push({ dtype: opts.dtype, device: opts.device });
        return opts.device === 'webgpu' ? silentWebGpu : slowWasm;
      },
      onStageStart: (info) => stages.push(info),
      onProgress: vi.fn(),
      nowMs: () => clockMs,
    });

    expect(loadCalls).toEqual([
      { dtype: 'fp32', device: 'webgpu' },
      { dtype: 'q8', device: 'wasm' },
    ]);
    expect(stages).toEqual([
      { backend: 'webgpu', sizeMb: 330 },
      { backend: 'wasm', sizeMb: 90 },
    ]);
    expect(result.backend).toBe('wasm');
    expect(result.sizeMb).toBe(90);
    expect(result.tooSlow).toBe(true);
  });

  it('skips WebGPU and loads WASM q8 directly when no WebGPU adapter is available', async () => {
    const loadCalls: Array<{ dtype: string; device: string }> = [];
    let clockMs = 0;

    const fastWasm: KokoroModelLike = {
      generate: vi.fn(async () => {
        clockMs += 300;
        return makeAudio(24000, 0.2);
      }),
    };

    const result = await loadKokoroWithFallback({
      hasWebGpuAdapter: async () => false,
      loadModel: async (opts) => {
        loadCalls.push({ dtype: opts.dtype, device: opts.device });
        return fastWasm;
      },
      onStageStart: vi.fn(),
      onProgress: vi.fn(),
      nowMs: () => clockMs,
    });

    expect(loadCalls).toEqual([{ dtype: 'q8', device: 'wasm' }]);
    expect(result.backend).toBe('wasm');
    expect(result.sizeMb).toBe(90);
    expect(result.tooSlow).toBe(false);
  });
});
