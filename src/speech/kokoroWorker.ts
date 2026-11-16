import { KokoroTTS } from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type IncomingMessage =
  | { type: 'load' }
  | { type: 'cancelJob'; jobId: number }
  | { type: 'synthesizeChunk'; jobId: number; chunkIndex: number; text: string; voice: string; speed: number };

let ttsPromise: Promise<KokoroTTS> | null = null;
let ttsInstance: KokoroTTS | null = null;
let loadedTooSlow = false;
const fileProgress = new Map<string, { loaded: number; total: number }>();
const cancelledJobs = new Set<number>();

export function hasAudiblePcm(samples: Float32Array | ArrayLike<number>): boolean {
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

async function runCalibration(instance: KokoroTTS): Promise<boolean> {
  try {
    // Pass 1: warm up JIT/WASM allocations and discard timing.
    await instance.generate('Warm up.', { voice: 'af_heart', speed: 1 });

    // Pass 2: time a short calibration sentence against real-time audio duration.
    const startedAt = performance.now();
    const calibration = await instance.generate(
      'AllHail helps students listen clearly.',
      { voice: 'af_heart', speed: 1 },
    );
    const generationMs = performance.now() - startedAt;
    const sampleRate = calibration.sampling_rate || 24000;
    const audioMs = (calibration.audio.length / sampleRate) * 1000;

    if (!hasAudiblePcm(calibration.audio) || audioMs <= 0) {
      return true;
    }
    return generationMs > audioMs;
  } catch {
    return true;
  }
}

async function loadModel(): Promise<KokoroTTS> {
  if (ttsInstance) return ttsInstance;
  if (ttsPromise) return ttsPromise;

  self.postMessage({ type: 'status', status: 'downloading', progress: 0 });

  ttsPromise = (async () => {
    try {
      // Only run q8 with device "wasm"; WebGPU q8 produces silent NaN tensors on Chrome.
      const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: reportProgress,
      });
      loadedTooSlow = await runCalibration(instance);
      ttsInstance = instance;
      self.postMessage({ type: 'status', status: 'ready', progress: 100, tooSlow: loadedTooSlow });
      return instance;
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
