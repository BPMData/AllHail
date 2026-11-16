import { describe, expect, it, vi } from 'vitest';
import { applyChunkEdgeFade } from './chunkAudioPlayer.ts';
import { PiperBrowserClient, type PiperSynthesizer } from './piperClient.ts';
import { buildTestWavArrayBuffer } from './piperLoader.test.ts';

function makeMockWavAudioContext() {
  const starts: Array<{ when: number; offset: number; rate: number }> = [];
  const channelSamplesWritten: Float32Array[] = [];

  const createBufferSource = vi.fn(() => {
    const node = {
      buffer: null as AudioBuffer | null,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null as null | (() => void),
      start: vi.fn((when = 0, offset = 0) => {
        starts.push({ when, offset, rate: node.playbackRate.value });
      }),
      stop: vi.fn(),
    };
    return node as unknown as AudioBufferSourceNode;
  });

  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 5,
    sampleRate: 48000,
    destination: {} as AudioDestinationNode,
    resume: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn(async (buf: ArrayBuffer) => {
      // Simulate AudioContext resampling Piper's 22050 Hz WAV up to 48000 Hz (0.5s audio)
      const pcm = new Float32Array(24000).fill(0.4);
      channelSamplesWritten.push(pcm);
      expect(buf.byteLength).toBeGreaterThan(44);
      return {
        duration: 0.5,
        length: pcm.length,
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => pcm,
      } as unknown as AudioBuffer;
    }),
    createBufferSource,
  };

  return { ctx: ctx as unknown as AudioContext, starts, channelSamplesWritten };
}

describe('PiperBrowserClient', () => {
  it('marks Piper unavailable cleanly when OPFS is blocked (e.g. private browsing)', async () => {
    const createWorker = vi.fn();
    const warmRuntime = vi.fn();
    const client = new PiperBrowserClient({
      checkOpfs: async () => false,
      warmRuntime,
      createWorker,
    });

    client.startDownload();
    await vi.waitFor(() => {
      expect(client.getState().status).toBe('unavailable');
    });
    expect(warmRuntime).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('sends reset: true to the worker on Retry download', async () => {
    const posted: unknown[] = [];
    const fakeWorker = {
      addEventListener: vi.fn(),
      postMessage: vi.fn((msg) => posted.push(msg)),
      terminate: vi.fn(),
    } as unknown as Worker;

    const client = new PiperBrowserClient({
      checkOpfs: async () => true,
      warmRuntime: async (onProgress) => onProgress(1),
      createWorker: () => fakeWorker,
    });

    client.startDownload();
    await vi.waitFor(() => {
      expect(posted).toEqual([{ type: 'load', reset: false }]);
    });

    client.retryDownload();
    await vi.waitFor(() => {
      expect(posted).toEqual([
        { type: 'load', reset: false },
        { type: 'load', reset: true },
      ]);
    });
    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('decodes Piper WAV via AudioContext.decodeAudioData, applies 8 ms edge fades, and applies speech rate', async () => {
    const { ctx, starts, channelSamplesWritten } = makeMockWavAudioContext();
    let resolveChunk1!: (wav: ArrayBuffer) => void;

    const synthesizer: PiperSynthesizer = {
      synthesizeChunk: vi.fn(({ chunkIndex }) => {
        if (chunkIndex === 0) {
          return Promise.resolve(buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 11025 }));
        }
        return new Promise<ArrayBuffer>((resolve) => {
          resolveChunk1 = resolve;
        });
      }),
      cancelJob: vi.fn(),
    };

    const client = new PiperBrowserClient({
      synthesizer,
      createAudioContext: () => ctx,
    });

    const onStart = vi.fn();
    client.speak('Short first sentence. Second sentence arrives later.', {
      rate: 1.25,
      onStart,
    });

    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    expect(starts).toHaveLength(1);
    expect(starts[0].rate).toBe(1.25);

    // Verify 8 ms edge fade-in and fade-out was applied directly to the decoded AudioBuffer PCM
    const faded = channelSamplesWritten[0];
    expect(faded[0]).toBe(0);
    expect(faded[faded.length - 1]).toBe(0);
    expect(Math.abs(faded[500] - 0.4)).toBeLessThan(0.001);

    // Chunk 1 schedules smoothly accounting for playback rate (0.5s buffer / 1.25x = 0.4s wall time)
    resolveChunk1(buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 11025 }));
    await vi.waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    expect(starts[1].when).toBeCloseTo(starts[0].when + 0.4, 3);
  });

  it('applies exact 8 ms fade window mathematically on any sample rate', () => {
    const pcm = new Float32Array(1000).fill(1.0);
    applyChunkEdgeFade(pcm, 1000, 8); // 8 samples at 1000 Hz = 8 ms
    expect(pcm[0]).toBe(0);
    expect(pcm[7]).toBeCloseTo(7 / 8, 5);
    expect(pcm[8]).toBe(1.0);
    expect(pcm[991]).toBe(1.0);
    expect(pcm[999]).toBe(0);
  });
});
