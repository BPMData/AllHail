import { TtsSession } from '@mintplex-labs/piper-tts-web';
import { PIPER_TOTAL_SIZE_MB, PIPER_VOICE_ID } from './piperAssets.ts';
import {
  inspectWavArrayBuffer,
  loadPiperSession,
  resetPiperSingleton,
  type PiperProgressEvent,
} from './piperLoader.ts';

type IncomingMessage =
  | { type: 'load'; reset?: boolean }
  | { type: 'cancelJob'; jobId: number }
  | { type: 'synthesizeChunk'; jobId: number; chunkIndex: number; text: string };

let sessionPromise: Promise<TtsSession> | null = null;
let sessionInstance: TtsSession | null = null;
const cancelledJobs = new Set<number>();

function reportModelProgress(event: PiperProgressEvent) {
  if (typeof event.loaded === 'number' && typeof event.total === 'number' && event.total > 0) {
    const pct = Math.min(99, Math.max(0, Math.round((event.loaded / event.total) * 100)));
    self.postMessage({
      type: 'status',
      status: 'downloading',
      modelProgress: pct,
      sizeMb: PIPER_TOTAL_SIZE_MB,
    });
  }
}

async function ensureSession(reset = false): Promise<TtsSession> {
  if (reset) {
    sessionInstance = null;
    sessionPromise = null;
    resetPiperSingleton(TtsSession);
  }
  if (sessionInstance) return sessionInstance;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    try {
      const loaded = await loadPiperSession<TtsSession>({
        sessionClass: TtsSession as unknown as import('./piperLoader.ts').PiperSessionConstructorLike<TtsSession>,
        reset,
        onProgress: reportModelProgress,
        sizeMb: PIPER_TOTAL_SIZE_MB,
      });
      sessionInstance = loaded.session;
      self.postMessage({
        type: 'status',
        status: 'ready',
        progress: 100,
        voiceId: PIPER_VOICE_ID,
        sizeMb: loaded.sizeMb,
        tooSlow: loaded.tooSlow,
      });
      return loaded.session;
    } catch (error) {
      sessionInstance = null;
      sessionPromise = null;
      resetPiperSingleton(TtsSession);
      throw error;
    }
  })();

  return sessionPromise;
}

self.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'load') {
    void ensureSession(Boolean(data.reset)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to load Piper';
      self.postMessage({
        type: 'status',
        status: 'error',
        error: message,
        sizeMb: PIPER_TOTAL_SIZE_MB,
      });
    });
    return;
  }

  if (data.type === 'cancelJob') {
    cancelledJobs.add(data.jobId);
    if (cancelledJobs.size > 200) {
      const oldest = cancelledJobs.values().next().value;
      if (typeof oldest === 'number') cancelledJobs.delete(oldest);
    }
    return;
  }

  if (data.type === 'synthesizeChunk') {
    if (cancelledJobs.has(data.jobId)) return;
    void (async () => {
      try {
        const session = await ensureSession(false);
        if (cancelledJobs.has(data.jobId)) return;
        const wavBlob = await session.predict(data.text);
        if (cancelledJobs.has(data.jobId)) return;
        const wavBuffer = await wavBlob.arrayBuffer();
        const inspected = inspectWavArrayBuffer(wavBuffer);
        if (!inspected.audible) {
          throw new Error('Piper generated silent or invalid WAV audio');
        }
        self.postMessage(
          { type: 'chunkWav', jobId: data.jobId, chunkIndex: data.chunkIndex, wavBuffer },
          { transfer: [wavBuffer] }
        );
      } catch (error: unknown) {
        if (cancelledJobs.has(data.jobId)) return;
        const message = error instanceof Error ? error.message : 'Piper synthesis failed';
        self.postMessage({ type: 'chunkError', jobId: data.jobId, chunkIndex: data.chunkIndex, error: message });
      }
    })();
  }
});
