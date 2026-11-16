import { splitTextForSpeech } from '../../shared/speechChunks.ts';
import type { KokoroBackend } from './kokoroLoader.ts';

export type KokoroStatus = 'idle' | 'downloading' | 'ready' | 'error';

export type KokoroState = {
  status: KokoroStatus;
  progress: number;
  tooSlow: boolean;
  startedAt: number | null;
  backend?: KokoroBackend;
  sizeMb?: number;
  error?: string;
};

export type KokoroPlaybackCallbacks = {
  rate: number;
  voice: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
};

export type SpeechControlHandle = {
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

type WorkerEvent =
  | {
      type: 'status';
      status: KokoroStatus;
      progress?: number;
      tooSlow?: boolean;
      backend?: KokoroBackend;
      sizeMb?: number;
      error?: string;
    }
  | { type: 'chunkAudio'; jobId: number; chunkIndex: number; samples: Float32Array; sampleRate: number }
  | { type: 'chunkError'; jobId: number; chunkIndex: number; error: string };

export type KokoroSynthesizer = {
  synthesizeChunk: (args: {
    jobId: number;
    chunkIndex: number;
    text: string;
    voice: string;
    speed: number;
  }) => Promise<{ samples: Float32Array; sampleRate: number }>;
  cancelJob: (jobId: number) => void;
};

export type KokoroClientOptions = {
  createWorker?: () => Worker;
  createAudioContext?: () => AudioContext;
  synthesizer?: KokoroSynthesizer;
};

export function isAudibleWaveform(samples: Float32Array): boolean {
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

type ScheduledItem = {
  buffer: AudioBuffer;
  startTime: number;
  endTime: number;
  node: AudioBufferSourceNode | null;
};

export class KokoroBrowserClient {
  private worker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private state: KokoroState = { status: 'idle', progress: 0, tooSlow: false, startedAt: null };
  private listeners = new Set<(state: KokoroState) => void>();
  private pendingChunks = new Map<
    string,
    { resolve: (data: { samples: Float32Array; sampleRate: number }) => void; reject: (err: Error) => void }
  >();
  private nextJobId = 1;
  private options: KokoroClientOptions;

  constructor(options: KokoroClientOptions = {}) {
    this.options = options;
  }

  getState(): KokoroState {
    return this.state;
  }

  isSupported(): boolean {
    return Boolean(this.options.synthesizer) || typeof Worker !== 'undefined';
  }

  isReady(): boolean {
    return this.state.status === 'ready';
  }

  isTooSlow(): boolean {
    return this.state.tooSlow;
  }

  /** Test/helper hook for state transitions. */
  setExternalState(patch: Partial<KokoroState>): void {
    this.setState({ ...this.state, ...patch });
  }

  subscribe(listener: (state: KokoroState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: KokoroState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private getOrCreateAudioContext(): AudioContext | null {
    if (typeof window === 'undefined' && !this.options.createAudioContext) return null;
    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        if (this.options.createAudioContext) {
          this.audioCtx = this.options.createAudioContext();
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

  /**
   * Must be invoked synchronously inside a user tap handler on iOS so later
   * asynchronous Kokoro audio buffers are allowed to play.
   */
  unlockAudioContext(): void {
    const ctx = this.getOrCreateAudioContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
    } catch {
      // AudioContext unsupported or blocked.
    }
  }

  /**
   * Plays a crisp, brief synthesized confirmation click when settings save automatically.
   */
  playSettingsClick(): void {
    const ctx = this.getOrCreateAudioContext();
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

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.isSupported()) {
      throw new Error('Web Workers unavailable');
    }
    const worker = this.options.createWorker
      ? this.options.createWorker()
      : new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'status') {
        const startedAt =
          msg.status === 'downloading'
            ? (this.state.startedAt ?? Date.now())
            : msg.status === 'idle'
              ? null
              : this.state.startedAt;
        this.setState({
          status: msg.status,
          progress: msg.progress ?? this.state.progress,
          tooSlow: typeof msg.tooSlow === 'boolean' ? msg.tooSlow : this.state.tooSlow,
          startedAt,
          backend: msg.backend ?? this.state.backend,
          sizeMb: msg.sizeMb ?? this.state.sizeMb,
          error: msg.error,
        });
        return;
      }
      if (msg.type === 'chunkAudio') {
        const key = `${msg.jobId}:${msg.chunkIndex}`;
        const pending = this.pendingChunks.get(key);
        if (pending) {
          this.pendingChunks.delete(key);
          pending.resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
        }
        return;
      }
      if (msg.type === 'chunkError') {
        const key = `${msg.jobId}:${msg.chunkIndex}`;
        const pending = this.pendingChunks.get(key);
        if (pending) {
          this.pendingChunks.delete(key);
          pending.reject(new Error(msg.error));
        }
      }
    });
    worker.addEventListener('error', (event) => {
      this.setState({
        status: 'error',
        progress: 0,
        tooSlow: this.state.tooSlow,
        startedAt: null,
        error: event.message || 'Kokoro worker error',
      });
      for (const [, pending] of this.pendingChunks) {
        pending.reject(new Error('Kokoro worker crashed'));
      }
      this.pendingChunks.clear();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  startDownload(): void {
    if (!this.isSupported()) return;
    if (this.state.status === 'ready' || this.state.status === 'downloading') return;
    try {
      this.setState({
        status: 'downloading',
        progress: 0,
        tooSlow: false,
        startedAt: Date.now(),
      });
      const worker = this.ensureWorker();
      worker.postMessage({ type: 'load' });
    } catch (error) {
      this.setState({
        status: 'error',
        progress: 0,
        tooSlow: false,
        startedAt: null,
        error: error instanceof Error ? error.message : 'Unable to start Kokoro worker',
      });
    }
  }

  retryDownload(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setState({ status: 'idle', progress: 0, tooSlow: false, startedAt: null });
    this.startDownload();
  }

  private requestChunk(
    jobId: number,
    chunkIndex: number,
    text: string,
    voice: string,
    speed: number,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (this.options.synthesizer) {
      return this.options.synthesizer.synthesizeChunk({ jobId, chunkIndex, text, voice, speed });
    }
    const worker = this.ensureWorker();
    const key = `${jobId}:${chunkIndex}`;
    return new Promise<{ samples: Float32Array; sampleRate: number }>((resolve, reject) => {
      this.pendingChunks.set(key, { resolve, reject });
      worker.postMessage({
        type: 'synthesizeChunk',
        jobId,
        chunkIndex,
        text,
        voice,
        speed,
      });
    });
  }

  private cancelWorkerJob(jobId: number): void {
    if (this.options.synthesizer) {
      this.options.synthesizer.cancelJob(jobId);
    } else if (this.worker) {
      this.worker.postMessage({ type: 'cancelJob', jobId });
    }
    for (const [key, pending] of this.pendingChunks) {
      if (key.startsWith(`${jobId}:`)) {
        this.pendingChunks.delete(key);
        pending.reject(new Error('Job cancelled'));
      }
    }
  }

  /**
   * Streams speech sentence by sentence: synthesizes chunk 0 immediately, starts playing
   * as soon as chunk 0 is ready, and synthesizes + queues subsequent chunks back-to-back.
   */
  speak(text: string, callbacks: KokoroPlaybackCallbacks): SpeechControlHandle {
    const chunks = splitTextForSpeech(text);
    if (chunks.length === 0) {
      queueMicrotask(() => callbacks.onEnd?.());
      return { pause: () => undefined, resume: () => undefined, stop: () => undefined };
    }

    const jobId = this.nextJobId++;
    let cancelled = false;
    let paused = false;
    let started = false;
    let synthesisDone = false;
    let nextStartTime = 0;

    // Track queued buffers with offsets so pause/resume works accurately across multi-chunk playback.
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
      const durationLeft = Math.max(0.01, buffer.duration - offsetSeconds);
      const endAt = startAt + durationLeft;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);

      const entry: ScheduledItem = { buffer, startTime: startAt, endTime: endAt, node };
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
        const ctx = this.getOrCreateAudioContext();
        if (!ctx) {
          throw new Error('AudioContext unavailable');
        }
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }

        // Request chunk 0 immediately.
        let nextPromise: Promise<{ samples: Float32Array; sampleRate: number }> | null =
          this.requestChunk(jobId, 0, chunks[0], callbacks.voice, callbacks.rate);

        for (let i = 0; i < chunks.length; i += 1) {
          if (cancelled) return;
          const currentResult = await nextPromise!;
          if (cancelled) return;

          if (!isAudibleWaveform(currentResult.samples)) {
            throw new Error('Kokoro returned silent or invalid audio');
          }

          // Start synthesizing the next sentence in the background immediately while current audio plays!
          if (i + 1 < chunks.length) {
            nextPromise = this.requestChunk(
              jobId,
              i + 1,
              chunks[i + 1],
              callbacks.voice,
              callbacks.rate,
            );
          } else {
            nextPromise = null;
          }

          const buffer = ctx.createBuffer(1, currentResult.samples.length, currentResult.sampleRate);
          buffer.copyToChannel(new Float32Array(currentResult.samples), 0);

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
        this.cancelWorkerJob(jobId);
        cleanupNodes();
        callbacks.onError?.(error instanceof Error ? error : new Error('Kokoro playback failed'));
      }
    };

    void run();

    return {
      pause: () => {
        if (cancelled || paused || !this.audioCtx) return;
        paused = true;
        const now = this.audioCtx.currentTime;
        const remainingBuffers: AudioBuffer[] = [];
        let firstOffset = 0;

        for (const item of queue) {
          if (now < item.endTime) {
            if (remainingBuffers.length === 0) {
              firstOffset = Math.max(0, now - item.startTime);
            }
            remainingBuffers.push(item.buffer);
          }
        }
        cleanupNodes();
        queue.length = 0;
        pausedSnapshot = { buffers: remainingBuffers, firstOffset };
      },
      resume: () => {
        if (cancelled || !paused || !this.audioCtx || !pausedSnapshot) return;
        paused = false;
        const ctx = this.audioCtx;
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
        this.cancelWorkerJob(jobId);
        cleanupNodes();
        queue.length = 0;
      },
    };
  }
}
