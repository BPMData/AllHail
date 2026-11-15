import { KokoroTTS } from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type IncomingMessage =
  | { type: 'load' }
  | { type: 'synthesize'; id: string; text: string; voice: string; speed: number };

let ttsPromise: Promise<KokoroTTS> | null = null;
let ttsInstance: KokoroTTS | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();

function reportProgress(event: {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}) {
  if (event.file && typeof event.loaded === 'number' && typeof event.total === 'number' && event.total > 0) {
    fileProgress.set(event.file, { loaded: event.loaded, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const entry of fileProgress.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
    self.postMessage({ type: 'status', status: 'downloading', progress: pct });
    return;
  }
  if (typeof event.progress === 'number') {
    self.postMessage({
      type: 'status',
      status: 'downloading',
      progress: Math.min(99, Math.max(0, Math.round(event.progress))),
    });
  }
}

async function loadModel(): Promise<KokoroTTS> {
  if (ttsInstance) return ttsInstance;
  if (ttsPromise) return ttsPromise;

  self.postMessage({ type: 'status', status: 'downloading', progress: 0 });

  ttsPromise = (async () => {
    const preferWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    try {
      const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: preferWebGpu ? 'webgpu' : 'wasm',
        progress_callback: reportProgress,
      });
      ttsInstance = instance;
      self.postMessage({ type: 'status', status: 'ready', progress: 100 });
      return instance;
    } catch (firstError) {
      if (preferWebGpu) {
        try {
          const fallback = await KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: reportProgress,
          });
          ttsInstance = fallback;
          self.postMessage({ type: 'status', status: 'ready', progress: 100 });
          return fallback;
        } catch (secondError) {
          ttsPromise = null;
          throw secondError;
        }
      }
      ttsPromise = null;
      throw firstError;
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

  if (data.type === 'synthesize') {
    void (async () => {
      try {
        const tts = await loadModel();
        const audio = await tts.generate(data.text, {
          voice: data.voice as Parameters<KokoroTTS['generate']>[1] extends { voice?: infer V } ? V : never,
          speed: data.speed,
        });
        const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        const sampleRate = audio.sampling_rate || 24000;
        self.postMessage(
          { type: 'audio', id: data.id, samples, sampleRate },
          { transfer: [samples.buffer] },
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Kokoro synthesis failed';
        self.postMessage({ type: 'audioError', id: data.id, error: message });
      }
    })();
  }
});
