import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import {
  hasAudiblePcm,
  isKokoroModelCached,
  KOKORO_MODEL_ID,
  loadKokoroWebGpu,
  type KokoroBackend,
  type KokoroLoadProgress,
} from './kokoroLoader.ts';

// Point Transformers.js ONNX runtime WASM helpers at our self-hosted single-version binaries.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = '/ort/';
}

type IncomingMessage =
  | { type: 'load' }
  | { type: 'cancelJob'; jobId: number }
  | { type: 'synthesizeChunk'; jobId: number; chunkIndex: number; text: string; voice: string; speed: number };

let ttsPromise: Promise<KokoroTTS> | null = null;
let ttsInstance: KokoroTTS | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();
const cancelledJobs = new Set<number>();

function reportProgress(
  event: KokoroLoadProgress,
  info: { backend: KokoroBackend; sizeMb: number; cached: boolean },
) {
  if (event.file && typeof event.loaded === 'number' && typeof event.total === 'number' && event.total > 0) {
    fileProgress.set(event.file, { loaded: event.loaded, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const entry of fileProgress.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
    self.postMessage({
      type: 'status',
      status: 'downloading',
      progress: pct,
      backend: info.backend,
      sizeMb: info.sizeMb,
      cached: info.cached,
    });
    return;
  }
  if (typeof event.progress === 'number') {
    self.postMessage({
      type: 'status',
      status: 'downloading',
      progress: Math.min(99, Math.max(0, Math.round(event.progress))),
      backend: info.backend,
      sizeMb: info.sizeMb,
      cached: info.cached,
    });
  }
}

async function detectWebGpuAdapter(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  try {
    const adapter = await (navigator as Navigator & { gpu: { requestAdapter: () => Promise<unknown> } })
      .gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function loadModel(): Promise<KokoroTTS> {
  if (ttsInstance) return ttsInstance;
  if (ttsPromise) return ttsPromise;

  ttsPromise = (async () => {
    try {
      const loaded = await loadKokoroWebGpu<KokoroTTS>({
        hasWebGpuAdapter: detectWebGpuAdapter,
        isCached: () => isKokoroModelCached({ modelId: KOKORO_MODEL_ID }),
        loadModel: ({ dtype, device, progress_callback }) =>
          KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
            dtype,
            device,
            progress_callback,
          }),
        onStageStart: ({ backend, sizeMb, cached }) => {
          fileProgress.clear();
          self.postMessage({
            type: 'status',
            status: 'downloading',
            progress: 0,
            backend,
            sizeMb,
            cached,
          });
        },
        onProgress: reportProgress,
      });

      ttsInstance = loaded.instance;
      self.postMessage({
        type: 'status',
        status: 'ready',
        progress: 100,
        backend: loaded.backend,
        sizeMb: loaded.sizeMb,
        cached: loaded.cached,
        tooSlow: loaded.tooSlow,
      });
      return loaded.instance;
    } catch (error) {
      ttsPromise = null;
      throw error;
    }
  })();

  return ttsPromise;
}

self.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'load') {
    void loadModel().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to load Kokoro';
      self.postMessage({ type: 'status', status: 'error', error: message });
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
        const tts = await loadModel();
        if (cancelledJobs.has(data.jobId)) return;
        const audio = await tts.generate(data.text, {
          voice: data.voice as Parameters<KokoroTTS['generate']>[1] extends { voice?: infer V } ? V : never,
          speed: data.speed,
        });
        if (cancelledJobs.has(data.jobId)) return;
        const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        if (!hasAudiblePcm(samples)) {
          throw new Error('Kokoro generated silent or invalid PCM samples');
        }
        const sampleRate = audio.sampling_rate || 24000;
        self.postMessage(
          { type: 'chunkAudio', jobId: data.jobId, chunkIndex: data.chunkIndex, samples, sampleRate },
          { transfer: [samples.buffer] },
        );
      } catch (error: unknown) {
        if (cancelledJobs.has(data.jobId)) return;
        const message = error instanceof Error ? error.message : 'Kokoro synthesis failed';
        self.postMessage({ type: 'chunkError', jobId: data.jobId, chunkIndex: data.chunkIndex, error: message });
      }
    })();
  }
});
