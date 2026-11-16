import { Mp3Encoder } from '@breezystack/lamejs';
import type { PromptMode } from '../../shared/prompts.ts';
import { splitTextForSpeech } from '../../shared/speechChunks.ts';
import { cleanTextForSpeech } from '../../shared/speechCleaner.ts';
import type { DeviceClass, VoiceOrderPreference } from '../settings.ts';
import type { KokoroBrowserClient } from './kokoroClient.ts';
import type { PiperBrowserClient } from './piperClient.ts';
import { resolveVoiceOrder } from './speechCoordinator.ts';

export type OfflineMp3ProviderId = 'kokoro' | 'piper';

export type PcmChunk = {
  samples: Float32Array;
  sampleRate: number;
};

/**
 * Chooses the best ready offline voice capable of producing downloadable PCM audio
 * (Kokoro or Piper). Device voices (`speechSynthesis`) cannot export audio files.
 */
export function resolveMp3Provider(options: {
  deviceClass: DeviceClass;
  voiceOrder: VoiceOrderPreference;
  kokoroReady: boolean;
  kokoroAllowed: boolean;
  kokoroTooSlow: boolean;
  piperReady: boolean;
  piperAllowed: boolean;
  piperTooSlow: boolean;
}): OfflineMp3ProviderId | null {
  const preferredOrder = resolveVoiceOrder(
    options.deviceClass,
    options.voiceOrder,
    options.kokoroTooSlow,
    options.piperTooSlow,
  );
  const readySet = new Set<OfflineMp3ProviderId>();
  if (options.kokoroAllowed && options.kokoroReady) readySet.add('kokoro');
  if (options.piperAllowed && options.piperReady) readySet.add('piper');

  for (const id of preferredOrder) {
    if (id === 'kokoro' || id === 'piper') {
      if (readySet.has(id)) return id;
    }
  }

  // Fallback for file export: even a slower calibrated offline voice still works for saving MP3.
  const fullOrder = resolveVoiceOrder(options.deviceClass, options.voiceOrder, false, false);
  for (const id of fullOrder) {
    if (id === 'kokoro' || id === 'piper') {
      if (readySet.has(id)) return id;
    }
  }

  return null;
}

/**
 * Decodes a 16-bit PCM RIFF WAV buffer (mono or multi-channel downmixed to mono)
 * without requiring a browser AudioContext.
 */
export function parsePcmWav(buffer: ArrayBuffer): PcmChunk {
  if (!buffer || buffer.byteLength < 44) {
    throw new Error('WAV audio buffer is too small');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Invalid RIFF/WAVE header');
  }

  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (chunkId === 0x666d7420 && payloadOffset + 16 <= buffer.byteLength) {
      // "fmt "
      audioFormat = view.getUint16(payloadOffset, true);
      channels = Math.max(1, view.getUint16(payloadOffset + 2, true));
      sampleRate = view.getUint32(payloadOffset + 4, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);
    } else if (chunkId === 0x64617461) {
      // "data"
      dataOffset = payloadOffset;
      dataSize = Math.min(chunkSize, Math.max(0, buffer.byteLength - payloadOffset));
      break;
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || sampleRate <= 0 || dataOffset < 0 || dataSize <= 0) {
    throw new Error('Unsupported WAV format for MP3 export');
  }

  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    if (channels === 1) {
      samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
    } else {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        sum += view.getInt16(dataOffset + (i * channels + ch) * 2, true) / 32768;
      }
      samples[i] = sum / channels;
    }
  }

  return { samples, sampleRate };
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[Math.min(idx, samples.length - 1)];
    const s1 = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function applyEdgeFadeCopy(samples: Float32Array, sampleRate: number, fadeMs = 5): Float32Array {
  const out = new Float32Array(samples);
  const fadeSamples = Math.min(Math.floor(out.length / 2), Math.round((sampleRate * fadeMs) / 1000));
  if (fadeSamples <= 0) return out;
  for (let i = 0; i < fadeSamples; i += 1) {
    const gain = (i + 1) / fadeSamples;
    out[i] *= gain;
    out[out.length - 1 - i] *= gain;
  }
  return out;
}

/**
 * Combines normalized PCM chunks with short edge fades and inter-sentence pauses into 16-bit mono PCM.
 */
export function stitchPcmChunks(
  chunks: ReadonlyArray<PcmChunk>,
  gapMs = 250,
): { samples: Int16Array; sampleRate: number } {
  if (chunks.length === 0) {
    throw new Error('No audio chunks to encode');
  }
  const targetRate = chunks[0].sampleRate;
  const gapSamples = Math.max(0, Math.round((targetRate * gapMs) / 1000));

  const processed = chunks.map((chunk) => {
    const resampled = resampleLinear(chunk.samples, chunk.sampleRate, targetRate);
    return applyEdgeFadeCopy(resampled, targetRate);
  });

  const totalLength = processed.reduce(
    (sum, item, idx) => sum + item.length + (idx < processed.length - 1 ? gapSamples : 0),
    0,
  );
  const pcm16 = new Int16Array(totalLength);

  let writeOffset = 0;
  for (let c = 0; c < processed.length; c += 1) {
    const chunk = processed[c];
    for (let i = 0; i < chunk.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, chunk[i]));
      pcm16[writeOffset++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
    if (c < processed.length - 1) {
      writeOffset += gapSamples;
    }
  }

  return { samples: pcm16, sampleRate: targetRate };
}

/**
 * Encodes mono 16-bit PCM into a Schoology-compatible MP3 Blob using @breezystack/lamejs.
 */
export function encodeMonoMp3(samples: Int16Array, sampleRate: number, kbps = 96): Blob {
  if (samples.length === 0) {
    throw new Error('Cannot encode empty audio to MP3');
  }
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const mp3Parts: ArrayBuffer[] = [];
  const blockSize = 1152;

  for (let i = 0; i < samples.length; i += blockSize) {
    const slice = samples.subarray(i, Math.min(i + blockSize, samples.length));
    const encoded = encoder.encodeBuffer(slice);
    if (encoded.length > 0) {
      mp3Parts.push(new Uint8Array(encoded).buffer);
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Parts.push(new Uint8Array(flushed).buffer);
  }

  return new Blob(mp3Parts, { type: 'audio/mpeg' });
}

export function buildMp3Filename(options: {
  sourceName?: string;
  mode: PromptMode;
  createdAt?: number;
}): string {
  const modeSlug = options.mode === 'detail' ? 'full-detail' : 'quick-look';
  const rawBase = options.sourceName?.replace(/\.[^.]+$/, '').trim() ?? '';
  const sanitized = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  if (sanitized && sanitized !== 'image' && sanitized !== 'photo') {
    return `${sanitized}-${modeSlug}.mp3`;
  }

  const date = new Date(options.createdAt ?? Date.now());
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `allhail-${modeSlug}-${y}-${m}-${d}.mp3`;
}

export function triggerMp3Download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

export async function exportSpeechToMp3(options: {
  rawText: string;
  provider: OfflineMp3ProviderId;
  kokoroVoiceId: string;
  speechRate: number;
  kokoroClient: Pick<KokoroBrowserClient, 'synthesizeToChunks'>;
  piperClient: Pick<PiperBrowserClient, 'synthesizeToWavChunks'>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; provider: OfflineMp3ProviderId }> {
  const cleaned = cleanTextForSpeech(options.rawText);
  const chunksText = splitTextForSpeech(cleaned);
  if (chunksText.length === 0) {
    throw new Error('No speakable text to export');
  }

  let pcmChunks: PcmChunk[];
  if (options.provider === 'kokoro') {
    pcmChunks = await options.kokoroClient.synthesizeToChunks(cleaned, {
      voice: options.kokoroVoiceId,
      rate: options.speechRate,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  } else {
    const wavBuffers = await options.piperClient.synthesizeToWavChunks(cleaned, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
    pcmChunks = wavBuffers.map(parsePcmWav);
  }

  if (options.signal?.aborted) {
    throw new Error('MP3 export cancelled');
  }

  const stitched = stitchPcmChunks(pcmChunks);
  const blob = encodeMonoMp3(stitched.samples, stitched.sampleRate);
  return { blob, provider: options.provider };
}
