export type KokoroStatus = 'idle' | 'downloading' | 'ready' | 'error';

export type KokoroState = {
  status: KokoroStatus;
  progress: number;
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
  | { type: 'status'; status: KokoroStatus; progress?: number; error?: string }
  | { type: 'audio'; id: string; samples: Float32Array; sampleRate: number }
  | { type: 'audioError'; id: string; error: string };

export class KokoroBrowserClient {
  private worker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private state: KokoroState = { status: 'idle', progress: 0 };
  private listeners = new Set<(state: KokoroState) => void>();
  private pendingRequests = new Map<
    string,
    { resolve: (data: { samples: Float32Array; sampleRate: number }) => void; reject: (err: Error) => void }
  >();
  private nextId = 1;

  getState(): KokoroState {
    return this.state;
  }

  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  isReady(): boolean {
    return this.state.status === 'ready';
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

  /**
   * Must be invoked synchronously inside a user tap handler on iOS so later
   * asynchronous Kokoro audio buffers are allowed to play.
   */
  unlockAudioContext(): void {
    if (typeof window === 'undefined') return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new Ctor();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume().catch(() => undefined);
      }
    } catch {
      // AudioContext unsupported or blocked.
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.isSupported()) {
      throw new Error('Web Workers unavailable');
    }
    const worker = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'status') {
        this.setState({
          status: msg.status,
          progress: msg.progress ?? this.state.progress,
          error: msg.error,
        });
        return;
      }
      if (msg.type === 'audio') {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
        }
        return;
      }
      if (msg.type === 'audioError') {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.reject(new Error(msg.error));
        }
      }
    });
    worker.addEventListener('error', (event) => {
      this.setState({ status: 'error', progress: 0, error: event.message || 'Kokoro worker error' });
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Kokoro worker crashed'));
      }
      this.pendingRequests.clear();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  startDownload(): void {
    if (!this.isSupported()) return;
    if (this.state.status === 'ready' || this.state.status === 'downloading') return;
    try {
      this.setState({ status: 'downloading', progress: 0 });
      const worker = this.ensureWorker();
      worker.postMessage({ type: 'load' });
    } catch (error) {
      this.setState({
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : 'Unable to start Kokoro worker',
      });
    }
  }

  retryDownload(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setState({ status: 'idle', progress: 0 });
    this.startDownload();
  }

  speak(text: string, callbacks: KokoroPlaybackCallbacks): SpeechControlHandle {
    let cancelled = false;
    let paused = false;
    let source: AudioBufferSourceNode | null = null;
    let decodedBuffer: AudioBuffer | null = null;
    let startedAt = 0;
    let offsetSeconds = 0;

    const requestId = `k-${this.nextId++}`;

    const cleanupSource = () => {
      if (source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        try {
          source.disconnect();
        } catch {
          // Ignore disconnect failure.
        }
        source = null;
      }
    };

    const startPlayback = (buffer: AudioBuffer, offset: number) => {
      if (cancelled || !this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume().catch(() => undefined);
      }
      const node = this.audioCtx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.audioCtx.destination);
      source = node;
      startedAt = this.audioCtx.currentTime - offset;
      node.onended = () => {
        if (cancelled || paused) return;
        source = null;
        callbacks.onEnd?.();
      };
      node.start(0, Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.01))));
    };

    const run = async () => {
      try {
        this.unlockAudioContext();
        if (!this.audioCtx) {
          throw new Error('AudioContext unavailable');
        }
        const worker = this.ensureWorker();
        const result = await new Promise<{ samples: Float32Array; sampleRate: number }>((resolve, reject) => {
          this.pendingRequests.set(requestId, { resolve, reject });
          worker.postMessage({
            type: 'synthesize',
            id: requestId,
            text,
            voice: callbacks.voice,
            speed: callbacks.rate,
          });
        });

        if (cancelled) return;
        const audioBuffer = this.audioCtx.createBuffer(1, result.samples.length, result.sampleRate);
        audioBuffer.copyToChannel(new Float32Array(result.samples), 0);
        decodedBuffer = audioBuffer;
        callbacks.onStart?.();
        if (!paused) {
          startPlayback(audioBuffer, 0);
        }
      } catch (error) {
        if (cancelled) return;
        callbacks.onError?.(error instanceof Error ? error : new Error('Kokoro playback failed'));
      }
    };

    void run();

    return {
      pause: () => {
        if (cancelled || paused || !decodedBuffer || !this.audioCtx) return;
        paused = true;
        offsetSeconds = Math.max(0, this.audioCtx.currentTime - startedAt);
        cleanupSource();
      },
      resume: () => {
        if (cancelled || !paused || !decodedBuffer) return;
        paused = false;
        startPlayback(decodedBuffer, offsetSeconds);
      },
      stop: () => {
        cancelled = true;
        paused = false;
        this.pendingRequests.delete(requestId);
        cleanupSource();
      },
    };
  }
}
