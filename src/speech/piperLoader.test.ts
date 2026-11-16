import { describe, expect, it, vi } from 'vitest';
import {
  PIPER_RUNTIME_CACHE_NAME,
  PIPER_RUNTIME_FILES,
  PIPER_VOICE_ID,
  PIPER_WASM_PATHS,
  warmPiperRuntimeCache,
} from './piperAssets.ts';
import {
  inspectWavArrayBuffer,
  isOpfsAvailable,
  loadPiperSession,
  type PiperSessionConstructorLike,
  type PiperSessionLike,
} from './piperLoader.ts';

export function buildTestWavArrayBuffer({
  sampleRate = 22050,
  numSamples = 22050,
  amplitude = 8000,
}: {
  sampleRate?: number;
  numSamples?: number;
  amplitude?: number;
} = {}): ArrayBuffer {
  const headerSize = 44;
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buf);
  view.setUint32(0, 0x52494646, false); // RIFF
  view.setUint32(4, buf.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false); // WAVE
  view.setUint32(12, 0x666d7420, false); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); // data
  view.setUint32(40, dataSize, true);

  if (amplitude !== 0) {
    for (let i = 0; i < numSamples; i += 1) {
      view.setInt16(headerSize + i * 2, i % 2 === 0 ? amplitude : -amplitude, true);
    }
  }
  return buf;
}

describe('inspectWavArrayBuffer', () => {
  it('detects audible 22050 Hz WAV duration and rejects silent or corrupt WAV buffers', () => {
    const audible = buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 22050, amplitude: 5000 });
    expect(inspectWavArrayBuffer(audible)).toEqual({
      audible: true,
      durationMs: 1000,
      sampleRate: 22050,
    });

    const silent = buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 11025, amplitude: 0 });
    expect(inspectWavArrayBuffer(silent).audible).toBe(false);

    expect(inspectWavArrayBuffer(new ArrayBuffer(12)).audible).toBe(false);
  });
});

describe('isOpfsAvailable', () => {
  it('returns true when navigator.storage.getDirectory succeeds and false when unavailable or blocked', async () => {
    expect(await isOpfsAvailable(undefined)).toBe(false);
    expect(
      await isOpfsAvailable({
        getDirectory: vi.fn().mockRejectedValue(new DOMException('Blocked', 'SecurityError')),
      }),
    ).toBe(false);
    expect(
      await isOpfsAvailable({
        getDirectory: vi.fn().mockResolvedValue({} as FileSystemDirectoryHandle),
      }),
    ).toBe(true);
  });
});

describe('loadPiperSession', () => {
  it('creates ONE TtsSession with en_US-hfc_female-medium and self-hosted wasmPaths, discarding warm-up timing', async () => {
    let clockMs = 0;
    const predict = vi
      .fn()
      // Pass 1: warm-up (6000 ms discarded)
      .mockImplementationOnce(async () => {
        clockMs += 6000;
        return new Blob([buildTestWavArrayBuffer({ numSamples: 22050, amplitude: 6000 })]);
      })
      // Pass 2: fast calibration (350 ms for 1000 ms WAV)
      .mockImplementationOnce(async () => {
        clockMs += 350;
        return new Blob([buildTestWavArrayBuffer({ numSamples: 22050, amplitude: 6000 })]);
      });

    const mockSession: PiperSessionLike = { predict };
    const FakeTtsSession: PiperSessionConstructorLike = {
      _instance: null,
      create: vi.fn(async (opts) => {
        FakeTtsSession._instance = mockSession;
        expect(opts.voiceId).toBe(PIPER_VOICE_ID);
        expect(opts.wasmPaths).toEqual(PIPER_WASM_PATHS);
        return mockSession;
      }),
    };

    const result = await loadPiperSession({
      sessionClass: FakeTtsSession,
      nowMs: () => clockMs,
      sizeMb: 93,
    });

    expect(FakeTtsSession.create).toHaveBeenCalledTimes(1);
    expect(predict).toHaveBeenCalledTimes(2);
    expect(result.voiceId).toBe('en_US-hfc_female-medium');
    expect(result.tooSlow).toBe(false);
    expect(result.sizeMb).toBe(93);
  });

  it('clears TtsSession._instance = null on fatal failure and when Retry resets the session', async () => {
    const poisonedInstance = { poisoned: true };
    const healthySession: PiperSessionLike = {
      predict: vi.fn(async () => new Blob([buildTestWavArrayBuffer()])),
    };

    let attempt = 0;
    const FakeTtsSession: PiperSessionConstructorLike = {
      _instance: poisonedInstance,
      create: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          FakeTtsSession._instance = { broken: true };
          throw new Error('Model fetch interrupted');
        }
        expect(FakeTtsSession._instance).toBeNull();
        FakeTtsSession._instance = healthySession;
        return healthySession;
      }),
    };

    // First load fails after leaving a broken _instance -> loader must reset _instance = null.
    await expect(
      loadPiperSession({ sessionClass: FakeTtsSession, reset: true }),
    ).rejects.toThrow('Model fetch interrupted');
    expect(FakeTtsSession._instance).toBeNull();

    // Retry with reset: true sees _instance === null and creates a clean working session.
    FakeTtsSession._instance = poisonedInstance;
    const recovered = await loadPiperSession({ sessionClass: FakeTtsSession, reset: true });
    expect(recovered.session).toBe(healthySession);
    expect(FakeTtsSession.create).toHaveBeenCalledTimes(2);
  });
});

describe('warmPiperRuntimeCache', () => {
  it('stores self-hosted /ort/ and /piper/ runtime files in allhail-piper-runtime cache only when Piper downloads', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const match = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue({ match, put });
    const fakeCaches = { open } as unknown as CacheStorage;
    const fetchFn = vi.fn(async (url: string | URL | Request) => new Response(`bytes:${String(url)}`, { status: 200 }));
    const progressValues: number[] = [];

    await warmPiperRuntimeCache({
      cacheStorage: fakeCaches,
      fetchFn: fetchFn as unknown as typeof fetch,
      onProgress: (f) => progressValues.push(f),
    });

    expect(open).toHaveBeenCalledWith(PIPER_RUNTIME_CACHE_NAME);
    expect(fetchFn).toHaveBeenCalledTimes(PIPER_RUNTIME_FILES.length);
    for (const url of PIPER_RUNTIME_FILES) {
      expect(fetchFn).toHaveBeenCalledWith(url);
    }
    expect(put).toHaveBeenCalledTimes(PIPER_RUNTIME_FILES.length);
    expect(progressValues.at(-1)).toBe(1);
  });
});
