import {
  isAudibleAudioBuffer,
  SharedAudioContextManager,
  streamChunkedAudio,
  type SpeechControlHandle,
} from './chunkAudioPlayer.ts';
import { PIPER_TOTAL_SIZE_MB, warmPiperRuntimeCache } from './piperAssets.ts';
import { isOpfsAvailable } from './piperLoader.ts';

export type PiperStatus = 'idle' | 'downloading' | 'ready' | 'error' | 'unavailable';

export type PiperState = {
  status: PiperStatus;
  progress: number;
  tooSlow: boolean;
  startedAt: number | null;
  sizeMb: number;
  error?: string;
};

export type PiperPlaybackCallbacks = {
  rate: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
};

type WorkerEvent =
  | {
      type: 'status';
      status: PiperStatus;
      progress?: number;
      modelProgress?: number;
      tooSlow?: boolean;
      sizeMb?: number;
      error?: string;
    }
  | { type: 'chunkWav'; jobId: number; chunkIndex: number; wavBuffer: ArrayBuffer }
  | { type: 'chunkError'; jobId: number; chunkIndex: number; error: string };

export type PiperSynthesizer = {
  synthesizeChunk: (args: { jobId: number; chunkIndex: number; text: string }) => Promise<ArrayBuffer>;
  cancelJob: (jobId: number) => void;
};

export type PiperClientOptions = {
  createWorker?: () => Worker;
  createAudioContext?: () => AudioContext;
  audioManager?: SharedAudioContextManager;
  synthesizer?: PiperSynthesizer;
  checkOpfs?: () => Promise<boolean>;
  warmRuntime?: (onProgress: (fraction: number) => void) => Promise<void>;
};

const RUNTIME_PROGRESS_SHARE = 32;

export class PiperBrowserClient {
  private worker: Worker | null = null;
  private audioManager: SharedAudioContextManager;
  private state: PiperState = {
    status: 'idle',
    progress: 0,
    tooSlow: false,
    startedAt: null,
    sizeMb: PIPER_TOTAL_SIZE_MB,
  };
  private listeners = new Set<(state: PiperState) => void>();
  private pendingChunks = new Map<
    string,
    { resolve: (wavBuffer: ArrayBuffer) => void; reject: (err: Error) => void }
  >();
  private nextJobId = 1;
  private activeJobs = 0;
  private downloadGeneration = 0;
  private options: PiperClientOptions;

  constructor(options: PiperClientOptions = {}) {
    this.options = options;
    this.audioManager = options.audioManager ?? new SharedAudioContextManager(options.createAudioContext);
  }

  getState(): PiperState {
    return this.state;
  }

  isSupported(): boolean {
    return (
      Boolean(this.options.synthesizer || this.options.createWorker) ||
      typeof Worker !== 'undefined'
    );
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

  setExternalState(patch: Partial<PiperState>): void {
    this.setState({ ...this.state, ...patch });
  }

  subscribe(listener: (state: PiperState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: PiperState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  unlockAudioContext(): void {
    this.audioManager.unlock();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.isSupported()) {
      throw new Error('Web Workers unavailable');
    }
    const worker = this.options.createWorker
      ? this.options.createWorker()
      : new Worker(new URL('./piperWorker.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'status') {
        const progress =
          typeof msg.modelProgress === 'number'
            ? Math.min(
                99,
                Math.round(
                  RUNTIME_PROGRESS_SHARE +
                    (msg.modelProgress / 100) * (99 - RUNTIME_PROGRESS_SHARE),
                ),
              )
            : (msg.progress ?? this.state.progress);
        const startedAt =
          msg.status === 'downloading'
            ? (this.state.startedAt ?? Date.now())
            : msg.status === 'idle' || msg.status === 'unavailable'
              ? null
              : this.state.startedAt;
        this.setState({
          status: msg.status,
          progress,
          tooSlow: typeof msg.tooSlow === 'boolean' ? msg.tooSlow : this.state.tooSlow,
          startedAt,
          sizeMb: msg.sizeMb ?? this.state.sizeMb,
          error: msg.error,
        });
        return;
      }
      if (msg.type === 'chunkWav') {
        const key = `${msg.jobId}:${msg.chunkIndex}`;
        const pending = this.pendingChunks.get(key);
        if (pending) {
          this.pendingChunks.delete(key);
          pending.resolve(msg.wavBuffer);
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
        sizeMb: this.state.sizeMb,
        error: event.message || 'Piper worker error',
      });
      for (const [, pending] of this.pendingChunks) {
        pending.reject(new Error('Piper worker crashed'));
      }
      this.pendingChunks.clear();
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  startDownload(reset = false): void {
    if (!this.isSupported()) return;
    if (
      this.state.status === 'ready' ||
      this.state.status === 'downloading' ||
      this.state.status === 'unavailable'
    ) {
      return;
    }

    const gen = ++this.downloadGeneration;
    this.setState({
      status: 'downloading',
      progress: 0,
      tooSlow: false,
      startedAt: Date.now(),
      sizeMb: PIPER_TOTAL_SIZE_MB,
    });

    void (async () => {
      try {
        const checkOpfs = this.options.checkOpfs ?? (() => isOpfsAvailable());
        const opfsOk = await checkOpfs();
        if (gen !== this.downloadGeneration) return;
        if (!opfsOk) {
          this.setState({
            status: 'unavailable',
            progress: 0,
            tooSlow: false,
            startedAt: null,
            sizeMb: PIPER_TOTAL_SIZE_MB,
          });
          return;
        }

        const warmRuntime =
          this.options.warmRuntime ??
          ((onProgress) => warmPiperRuntimeCache({ onProgress }));

        await warmRuntime((fraction) => {
          if (gen !== this.downloadGeneration) return;
          const pct = Math.min(
            RUNTIME_PROGRESS_SHARE,
            Math.max(0, Math.round(fraction * RUNTIME_PROGRESS_SHARE)),
          );
          if (this.state.status === 'downloading' && pct > this.state.progress) {
            this.setState({
              ...this.state,
              progress: pct,
            });
          }
        });

        if (gen !== this.downloadGeneration) return;
        const worker = this.ensureWorker();
        worker.postMessage({ type: 'load', reset });
      } catch (error) {
        if (gen !== this.downloadGeneration) return;
        this.setState({
          status: 'error',
          progress: 0,
          tooSlow: false,
          startedAt: null,
          sizeMb: PIPER_TOTAL_SIZE_MB,
          error: error instanceof Error ? error.message : 'Unable to start Piper worker',
        });
      }
    })();
  }

  retryDownload(): void {
    this.downloadGeneration += 1;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setState({
      status: 'idle',
      progress: 0,
      tooSlow: false,
      startedAt: null,
      sizeMb: PIPER_TOTAL_SIZE_MB,
    });
    this.startDownload(true);
  }

  private requestChunk(jobId: number, chunkIndex: number, text: string): Promise<ArrayBuffer> {
    if (this.options.synthesizer) {
      return this.options.synthesizer.synthesizeChunk({ jobId, chunkIndex, text });
    }
    const worker = this.ensureWorker();
    const key = `${jobId}:${chunkIndex}`;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pendingChunks.set(key, { resolve, reject });
      worker.postMessage({
        type: 'synthesizeChunk',
        jobId,
        chunkIndex,
        text,
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

  speak(text: string, callbacks: PiperPlaybackCallbacks): SpeechControlHandle {
    const jobId = this.nextJobId++;
    this.activeJobs += 1;
    let settled = false;
    const markDone = () => {
      if (!settled) {
        settled = true;
        this.activeJobs = Math.max(0, this.activeJobs - 1);
      }
    };

    const handle = streamChunkedAudio<ArrayBuffer>({
      text,
      audioManager: this.audioManager,
      playbackRate: callbacks.rate,
      requestChunk: (chunkIndex, chunkText) => this.requestChunk(jobId, chunkIndex, chunkText),
      toAudioBuffer: async (ctx, wavBuffer) => {
        const buffer = await ctx.decodeAudioData(wavBuffer.slice(0));
        if (!isAudibleAudioBuffer(buffer)) {
          throw new Error('Piper returned silent or invalid audio');
        }
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
      errorFallbackMessage: 'Piper playback failed',
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
