import { splitTextForSpeech } from '../../shared/speechChunks.ts';

export type SpeechControlHandle = {
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

export type ChunkPlaybackCallbacks = {
  rate?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
};

export const CHUNK_EDGE_FADE_MS = 8;

export function isAudibleWaveform(samples: Float32Array | ArrayLike<number>): boolean {
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

export function isAudibleAudioBuffer(buffer: AudioBuffer): boolean {
  if (!buffer || buffer.length === 0 || buffer.numberOfChannels <= 0) return false;
  if (typeof buffer.getChannelData !== 'function') {
    return buffer.duration > 0;
  }
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    if (isAudibleWaveform(buffer.getChannelData(c))) {
      return true;
    }
  }
  return false;
}

/**
 * Applies a short linear fade-in and fade-out (default 8 ms) directly to PCM samples
 * to avoid clicks or pops between adjacent synthesized chunks.
 */
export function applyChunkEdgeFade(
  samples: Float32Array,
  sampleRate: number,
  fadeMs = CHUNK_EDGE_FADE_MS
): Float32Array {
  if (!samples || samples.length < 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return samples;
  }
  const desiredFrames = Math.round((sampleRate * fadeMs) / 1000);
  const fadeFrames = Math.min(Math.floor(samples.length / 2), desiredFrames);
  if (fadeFrames <= 0) return samples;

  for (let i = 0; i < fadeFrames; i += 1) {
    const gainIn = i / fadeFrames;
    const gainOut = (fadeFrames - 1 - i) / fadeFrames;
    samples[i] *= gainIn;
    samples[samples.length - fadeFrames + i] *= gainOut;
  }
  return samples;
}

export function applyEdgeFadeToAudioBuffer(buffer: AudioBuffer, fadeMs = CHUNK_EDGE_FADE_MS): AudioBuffer {
  if (!buffer || typeof buffer.getChannelData !== 'function') {
    return buffer;
  }
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    applyChunkEdgeFade(buffer.getChannelData(c), buffer.sampleRate, fadeMs);
  }
  return buffer;
}

export class SharedAudioContextManager {
  private audioCtx: AudioContext | null = null;
  private createAudioContext?: () => AudioContext;

  constructor(createAudioContext?: () => AudioContext) {
    this.createAudioContext = createAudioContext;
  }

  getOrCreate(): AudioContext | null {
    if (typeof window === 'undefined' && !this.createAudioContext) return null;
    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        if (this.createAudioContext) {
          this.audioCtx = this.createAudioContext();
        } else {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctor) return null;
          this.audioCtx = new Ctor();
        }
      }
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  unlock(): void {
    const ctx = this.getOrCreate();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
    } catch {
      // AudioContext unsupported or blocked.
    }
  }

  playSettingsClick(): void {
    const ctx = this.getOrCreate();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.03);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch {
      // Ignore audio click failures cleanly.
    }
  }
}

type ScheduledItem = {
  buffer: AudioBuffer;
  startTime: number;
  endTime: number;
  playbackRate: number;
  initialOffset: number;
  node: AudioBufferSourceNode | null;
};

/**
 * Streams chunked synthesis output cleanly through Web Audio:
 * fetches chunk 0 immediately, pre-fetches chunk N+1 while chunk N plays,
 * applies 8 ms fade-in/out ramps, and schedules AudioBuffers back-to-back.
 */
export function streamChunkedAudio<TChunk>({
  text,
  audioManager,
  playbackRate = 1,
  requestChunk,
  toAudioBuffer,
  cancelSynthesis,
  callbacks,
  errorFallbackMessage,
}: {
  text: string;
  audioManager: SharedAudioContextManager;
  playbackRate?: number;
  requestChunk: (chunkIndex: number, chunkText: string) => Promise<TChunk>;
  toAudioBuffer: (ctx: AudioContext, chunk: TChunk) => Promise<AudioBuffer>;
  cancelSynthesis: () => void;
  callbacks: ChunkPlaybackCallbacks;
  errorFallbackMessage: string;
}): SpeechControlHandle {
  const chunks = splitTextForSpeech(text);
  if (chunks.length === 0) {
    queueMicrotask(() => callbacks.onEnd?.());
    return { pause: () => undefined, resume: () => undefined, stop: () => undefined };
  }

  const safeRate = Number.isFinite(playbackRate) ? Math.min(2.5, Math.max(0.5, playbackRate)) : 1;

  let cancelled = false;
  let paused = false;
  let started = false;
  let synthesisDone = false;
  let nextStartTime = 0;

  const queue: ScheduledItem[] = [];
  let pausedSnapshot: { buffers: AudioBuffer[]; firstOffset: number } | null = null;

  const cleanupNodes = () => {
    for (const item of queue) {
      if (item.node) {
        item.node.onended = null;
        try {
          item.node.stop();
        } catch {
          // Already stopped.
        }
        try {
          item.node.disconnect();
        } catch {
          // Ignore disconnect failure.
        }
        item.node = null;
      }
    }
  };

  const finishIfComplete = () => {
    if (cancelled || paused || !synthesisDone) return;
    const anyPlaying = queue.some((item) => item.node !== null);
    if (!anyPlaying) {
      callbacks.onEnd?.();
    }
  };

  const scheduleBuffer = (ctx: AudioContext, buffer: AudioBuffer, offsetSeconds = 0) => {
    if (cancelled || paused) return;
    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.005, nextStartTime);
    const bufferDurationLeft = Math.max(0.01, buffer.duration - offsetSeconds);
    const wallDurationLeft = Math.max(0.01, bufferDurationLeft / safeRate);
    const endAt = startAt + wallDurationLeft;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    if (node.playbackRate && typeof node.playbackRate.value === 'number') {
      node.playbackRate.value = safeRate;
    }
    node.connect(ctx.destination);

    const entry: ScheduledItem = {
      buffer,
      startTime: startAt,
      endTime: endAt,
      playbackRate: safeRate,
      initialOffset: offsetSeconds,
      node,
    };
    queue.push(entry);
    nextStartTime = endAt;

    node.onended = () => {
      entry.node = null;
      if (!cancelled && !paused) {
        const idx = queue.indexOf(entry);
        if (idx >= 0) queue.splice(idx, 1);
        finishIfComplete();
      }
    };

    node.start(startAt, Math.max(0, Math.min(offsetSeconds, Math.max(0, buffer.duration - 0.01))));
  };

  const run = async () => {
    try {
      const ctx = audioManager.getOrCreate();
      if (!ctx) {
        throw new Error('AudioContext unavailable');
      }
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      let nextPromise: Promise<TChunk> | null = requestChunk(0, chunks[0]);

      for (let i = 0; i < chunks.length; i += 1) {
        if (cancelled) return;
        const currentChunk = await nextPromise!;
        if (cancelled) return;

        if (i + 1 < chunks.length) {
          nextPromise = requestChunk(i + 1, chunks[i + 1]);
        } else {
          nextPromise = null;
        }

        const buffer = await toAudioBuffer(ctx, currentChunk);
        if (cancelled) return;

        applyEdgeFadeToAudioBuffer(buffer, CHUNK_EDGE_FADE_MS);

        if (!started) {
          started = true;
          callbacks.onStart?.();
        }

        if (paused && pausedSnapshot) {
          pausedSnapshot.buffers.push(buffer);
        } else {
          scheduleBuffer(ctx, buffer, 0);
        }
      }

      synthesisDone = true;
      finishIfComplete();
    } catch (error) {
      if (cancelled) return;
      cancelSynthesis();
      cleanupNodes();
      callbacks.onError?.(error instanceof Error ? error : new Error(errorFallbackMessage));
    }
  };

  void run();

  return {
    pause: () => {
      const ctx = audioManager.getOrCreate();
      if (cancelled || paused || !ctx) return;
      paused = true;
      const now = ctx.currentTime;
      const remainingBuffers: AudioBuffer[] = [];
      let firstOffset = 0;

      for (const item of queue) {
        if (now < item.endTime) {
          if (remainingBuffers.length === 0) {
            const elapsedWall = Math.max(0, now - item.startTime);
            firstOffset = item.initialOffset + elapsedWall * item.playbackRate;
          }
          remainingBuffers.push(item.buffer);
        }
      }
      cleanupNodes();
      queue.length = 0;
      pausedSnapshot = { buffers: remainingBuffers, firstOffset };
    },
    resume: () => {
      const ctx = audioManager.getOrCreate();
      if (cancelled || !paused || !ctx || !pausedSnapshot) return;
      paused = false;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
      nextStartTime = ctx.currentTime;
      const { buffers, firstOffset } = pausedSnapshot;
      pausedSnapshot = null;
      buffers.forEach((buf, idx) => {
        scheduleBuffer(ctx, buf, idx === 0 ? firstOffset : 0);
      });
      finishIfComplete();
    },
    stop: () => {
      if (cancelled) return;
      cancelled = true;
      paused = false;
      pausedSnapshot = null;
      cancelSynthesis();
      cleanupNodes();
      queue.length = 0;
    },
  };
}
