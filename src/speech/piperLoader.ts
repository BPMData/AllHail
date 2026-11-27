import { isAudibleWaveform } from './chunkAudioPlayer.ts';
import { PIPER_TOTAL_SIZE_MB, PIPER_VOICE_ID, PIPER_WASM_PATHS } from './piperAssets.ts';

export type PiperWasmPaths = {
  onnxWasm: string | { readonly mjs: string; readonly wasm: string };
  piperWasm: string;
  piperData: string;
};

export type PiperProgressEvent = {
  url: string;
  total: number;
  loaded: number;
};

export type PiperSessionLike = {
  predict: (text: string) => Promise<Blob>;
};

export type PiperSessionConstructorLike<TSession extends PiperSessionLike = PiperSessionLike> = {
  _instance: unknown;
  create: (options: {
    voiceId: string;
    wasmPaths: PiperWasmPaths;
    progress?: (event: PiperProgressEvent) => void;
  }) => Promise<TSession>;
};

export type PiperLoadResult<TSession extends PiperSessionLike = PiperSessionLike> = {
  session: TSession;
  voiceId: typeof PIPER_VOICE_ID;
  sizeMb: number;
  tooSlow: boolean;
};

/**
 * Checks whether Origin Private File System (OPFS) is usable in the current context.
 * Returns false cleanly in unsupported browsers or restricted private windows.
 */
export async function isOpfsAvailable(
  storage: Pick<StorageManager, 'getDirectory'> | undefined = typeof navigator !== 'undefined'
    ? navigator.storage
    : undefined
): Promise<boolean> {
  if (!storage || typeof storage.getDirectory !== 'function') return false;
  try {
    await storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears `@mintplex-labs/piper-tts-web`'s cached singleton so Retry after a fatal
 * load or inference failure creates a fresh TtsSession cleanly.
 */
export function resetPiperSingleton(sessionClass: { _instance?: unknown }): void {
  sessionClass._instance = null;
}

/**
 * Parses a standard RIFF PCM WAV buffer produced by Piper (22,050 Hz, 16-bit mono)
 * and verifies audible non-zero samples plus exact audio duration in milliseconds.
 */
export function inspectWavArrayBuffer(buffer: ArrayBuffer): {
  audible: boolean;
  durationMs: number;
  sampleRate: number;
} {
  if (!buffer || buffer.byteLength < 44) {
    return { audible: false, durationMs: 0, sampleRate: 0 };
  }
  const view = new DataView(buffer);
  const riff = view.getUint32(0, false);
  const wave = view.getUint32(8, false);
  if (riff !== 0x52494646 || wave !== 0x57415645) {
    return { audible: false, durationMs: 0, sampleRate: 0 };
  }

  const numChannels = Math.max(1, view.getUint16(22, true));
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  let dataOffset = 44;
  let dataLength = buffer.byteLength - 44;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x64617461) {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buffer.byteLength - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (sampleRate <= 0 || dataLength <= 0 || bitsPerSample <= 0) {
    return { audible: false, durationMs: 0, sampleRate };
  }

  const bytesPerSample = Math.max(1, bitsPerSample / 8);
  const totalFrames = Math.floor(dataLength / (numChannels * bytesPerSample));
  const durationMs = (totalFrames / sampleRate) * 1000;

  if (bitsPerSample === 16) {
    const sampleCount = Math.floor(dataLength / 2);
    const normalized = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      normalized[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
    }
    return {
      audible: isAudibleWaveform(normalized) && durationMs > 0,
      durationMs,
      sampleRate,
    };
  }

  return { audible: durationMs > 0, durationMs, sampleRate };
}

export async function runPiperCalibration<TSession extends PiperSessionLike>(
  session: TSession,
  nowMs: () => number = () => performance.now()
): Promise<{ audible: boolean; tooSlow: boolean }> {
  try {
    // Pass 1: warm up phonemizer + WASM ORT session and discard timing.
    await session.predict('Warm up.');

    // Pass 2: measure steady-state synthesis vs real-time WAV duration.
    const startedAt = nowMs();
    const wavBlob = await session.predict('AllHail helps students listen clearly.');
    const generationMs = nowMs() - startedAt;
    const wavBuffer = await wavBlob.arrayBuffer();
    const inspected = inspectWavArrayBuffer(wavBuffer);

    if (!inspected.audible || inspected.durationMs <= 0) {
      return { audible: false, tooSlow: true };
    }
    return { audible: true, tooSlow: generationMs > inspected.durationMs };
  } catch {
    return { audible: false, tooSlow: true };
  }
}

export async function loadPiperSession<TSession extends PiperSessionLike>({
  sessionClass,
  reset = false,
  onProgress,
  nowMs = () => performance.now(),
  sizeMb = PIPER_TOTAL_SIZE_MB,
}: {
  sessionClass: PiperSessionConstructorLike<TSession>;
  reset?: boolean;
  onProgress?: (event: PiperProgressEvent) => void;
  nowMs?: () => number;
  sizeMb?: number;
}): Promise<PiperLoadResult<TSession>> {
  if (reset) {
    resetPiperSingleton(sessionClass);
  }

  let session: TSession;
  try {
    session = await sessionClass.create({
      voiceId: PIPER_VOICE_ID,
      wasmPaths: { ...PIPER_WASM_PATHS },
      progress: onProgress,
    });
  } catch (error) {
    resetPiperSingleton(sessionClass);
    throw error;
  }

  const cal = await runPiperCalibration(session, nowMs);
  if (!cal.audible) {
    resetPiperSingleton(sessionClass);
    throw new Error('Piper produced silent or invalid WAV audio');
  }

  return {
    session,
    voiceId: PIPER_VOICE_ID,
    sizeMb,
    tooSlow: cal.tooSlow,
  };
}
