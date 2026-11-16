import { splitTextForSpeech } from '../../shared/speechChunks.ts';
import {
  isAudibleWaveform,
  SharedAudioContextManager,
  streamChunkedAudio,
  type SpeechControlHandle,
} from './chunkAudioPlayer.ts';
import type { KokoroBackend } from './kokoroLoader.ts';

export type { SpeechControlHandle };
export { isAudibleWaveform };

export type KokoroStatus = 'idle' | 'skipped' | 'downloading' | 'ready' | 'error';

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
  audioManager?: SharedAudioContextManager;
  synthesizer?: KokoroSynthesizer;
};

export class KokoroBrowserClient {
  private worker: Worker | null = null;
  private audioManager: SharedAudioContextManager;
  private state: KokoroState = { status: 'idle', progress: 0, tooSlow: false, startedAt: null };
  private listeners = new Set<(state: KokoroState) => void>();
  private pendingChunks = new Map<
    string,
    { resolve: (data: { samples: Float32Array; sampleRate: number }) => void; reject: (err: Error) => void }
  >();
  private nextJobId = 1;
  private activeJobs = 0;
  private options: KokoroClientOptions;

  constructor(options: KokoroClientOptions = {}) {
    this.options = options;
    this.audioManager = options.audioManager ?? new SharedAudioContextManager(options.createAudioContext);
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

  isBusy(): boolean {
    return this.activeJobs > 0 || this.pendingChunks.size > 0;
  }

  /** Test/helper hook for state transitions. */
  setExternalState(patch: Partial<KokoroState>): void {
    this.setState({ ...this.state, ...patch });
  }

  markSkipped(): void {
    if (this.state.status === 'skipped') return;
    this.setState({
      status: 'skipped',
      progress: 0,
      tooSlow: false,
      startedAt: null,
    });
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

  unlockAudioContext(): void {
    this.audioManager.unlock();
  }

  playSettingsClick(): void {
    this.audioManager.playSettingsClick();
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
            : msg.status === 'idle' || msg.status === 'skipped'
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

  async synthesizeToChunks(
    cleanedText: string,
    options: {
      voice: string;
      rate: number;
      onProgress?: (done: number, total: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<Array<{ samples: Float32Array; sampleRate: number }>> {
    const chunksText = splitTextForSpeech(cleanedText);
    if (chunksText.length === 0) return [];

    const jobId = this.nextJobId++;
    this.activeJobs += 1;
    const onAbort = () => this.cancelWorkerJob(jobId);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const results: Array<{ samples: Float32Array; sampleRate: number }> = [];
      for (let i = 0; i < chunksText.length; i += 1) {
        if (options.signal?.aborted) {
          throw new Error('MP3 synthesis cancelled');
        }
        const chunk = await this.requestChunk(jobId, i, chunksText[i], options.voice, options.rate);
        if (!isAudibleWaveform(chunk.samples)) {
          throw new Error('Kokoro returned silent or invalid audio');
        }
        results.push(chunk);
        options.onProgress?.(i + 1, chunksText.length);
      }
      return results;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
    }
  }

  speak(text: string, callbacks: KokoroPlaybackCallbacks): SpeechControlHandle {
    const jobId = this.nextJobId++;
    this.activeJobs += 1;
    let settled = false;
    const markDone = () => {
      if (!settled) {
        settled = true;
        this.activeJobs = Math.max(0, this.activeJobs - 1);
      }
    };

    const handle = streamChunkedAudio<{ samples: Float32Array; sampleRate: number }>({
      text,
      audioManager: this.audioManager,
      playbackRate: 1,
      requestChunk: (chunkIndex, chunkText) =>
        this.requestChunk(jobId, chunkIndex, chunkText, callbacks.voice, callbacks.rate),
      toAudioBuffer: async (ctx, chunk) => {
        if (!isAudibleWaveform(chunk.samples)) {
          throw new Error('Kokoro returned silent or invalid audio');
        }
        const buffer = ctx.createBuffer(1, chunk.samples.length, chunk.sampleRate);
        buffer.copyToChannel(new Float32Array(chunk.samples), 0);
        return buffer;
      },
      cancelSynthesis: () => {
        markDone();
        this.cancelWorkerJob(jobId);
      },
      callbacks: {
        onStart: callbacks.onStart,
        onEnd: () => {
          markDone();
          callbacks.onEnd?.();
        },
        onError: (err) => {
          markDone();
          callbacks.onError?.(err);
        },
      },
      errorFallbackMessage: 'Kokoro playback failed',
    });

    return {
      pause: handle.pause,
      resume: handle.resume,
      stop: () => {
        markDone();
        handle.stop();
      },
    };
  }
}
