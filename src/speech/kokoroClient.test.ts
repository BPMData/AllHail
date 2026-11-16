import { describe, expect, it, vi } from 'vitest';
import { isAudibleWaveform, KokoroBrowserClient, type KokoroSynthesizer } from './kokoroClient.ts';

function makeMockAudioContext() {
  const starts: Array<{ when: number; offset: number }> = [];
  const createBufferSource = vi.fn(() => {
    const node = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null as null | (() => void),
      start: vi.fn((when = 0, offset = 0) => {
        starts.push({ when, offset });
      }),
      stop: vi.fn(),
    };
    return node as unknown as AudioBufferSourceNode;
  });

  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 10,
    destination: {} as AudioDestinationNode,
    resume: vi.fn().mockResolvedValue(undefined),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    })),
    createBufferSource,
    createOscillator: vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    })),
  };

  return { ctx: ctx as unknown as AudioContext, starts };
}

describe('KokoroBrowserClient sentence streaming queue', () => {
  it('starts playing chunk 0 immediately while chunk 1 is still synthesizing and queues back-to-back', async () => {
    const { ctx, starts } = makeMockAudioContext();
    let resolveChunk1!: (val: { samples: Float32Array; sampleRate: number }) => void;

    const synthesizer: KokoroSynthesizer = {
      synthesizeChunk: vi.fn(({ chunkIndex }) => {
        if (chunkIndex === 0) {
          return Promise.resolve({
            samples: new Float32Array(24000).fill(0.25), // 1.0s audio
            sampleRate: 24000,
          });
        }
        return new Promise<{ samples: Float32Array; sampleRate: number }>((resolve) => {
          resolveChunk1 = resolve;
        });
      }),
      cancelJob: vi.fn(),
    };

    const client = new KokoroBrowserClient({
      synthesizer,
      createAudioContext: () => ctx,
    });

    const onStart = vi.fn();
    const onError = vi.fn();
    client.speak('First short sentence. Second sentence arrives later.', {
      rate: 1,
      voice: 'af_heart',
      onStart,
      onError,
    });

    // Wait microtasks for chunk 0 to play BEFORE chunk 1 resolves.
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    expect(starts).toHaveLength(1);
    expect(starts[0].when).toBeCloseTo(10.005, 3);

    // Chunk 1 should already have been requested in background!
    expect(synthesizer.synthesizeChunk).toHaveBeenCalledTimes(2);

    // Resolve chunk 1 and verify it schedules right after chunk 0 ends (10.005 + 1.0).
    resolveChunk1({
      samples: new Float32Array(12000).fill(0.2),
      sampleRate: 24000,
    });

    await vi.waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    expect(starts[1].when).toBeCloseTo(11.005, 3);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects silent or NaN buffers cleanly', () => {
    expect(isAudibleWaveform(new Float32Array(0))).toBe(false);
    expect(isAudibleWaveform(new Float32Array(100))).toBe(false);
    expect(isAudibleWaveform(new Float32Array([0.1, Number.NaN, 0.2]))).toBe(false);
    expect(isAudibleWaveform(new Float32Array([0.0, 0.25, -0.25]))).toBe(true);
  });

  it('plays settings confirmation click cleanly without throwing', () => {
    const { ctx } = makeMockAudioContext();
    const client = new KokoroBrowserClient({ createAudioContext: () => ctx });
    expect(() => client.playSettingsClick()).not.toThrow();
    expect((ctx as unknown as { createOscillator: ReturnType<typeof vi.fn> }).createOscillator).toHaveBeenCalledTimes(1);
  });

  it('sets cached: true on initial downloading state when model is already cached', async () => {
    const postMessage = vi.fn();
    const fakeWorker = {
      addEventListener: vi.fn(),
      postMessage,
      terminate: vi.fn(),
    } as unknown as Worker;

    const client = new KokoroBrowserClient({
      createWorker: () => fakeWorker,
      isCached: async () => true,
    });

    client.startDownload();
    await vi.waitFor(() => {
      expect(client.getState().status).toBe('downloading');
    });
    expect(client.getState().cached).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'load' });
  });
});
