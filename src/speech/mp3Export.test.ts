import { describe, expect, it, vi } from 'vitest';
import { KokoroBrowserClient } from './kokoroClient.ts';
import {
  buildMp3Filename,
  encodeMonoMp3,
  exportSpeechToMp3,
  parsePcmWav,
  resolveMp3Provider,
  stitchPcmChunks,
} from './mp3Export.ts';
import { PiperBrowserClient } from './piperClient.ts';
import { buildTestWavArrayBuffer } from './piperLoader.test.ts';

function buildToneSamples(sampleRate: number, seconds: number, freq = 440): Float32Array {
  const count = Math.round(sampleRate * seconds);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = 0.25 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe('resolveMp3Provider', () => {
  it('picks Kokoro or Piper per preference and never picks device voice', () => {
    expect(
      resolveMp3Provider({
        deviceClass: 'laptop',
        voiceOrder: 'auto',
        kokoroReady: true,
        kokoroAllowed: true,
        kokoroTooSlow: false,
        piperReady: true,
        piperAllowed: true,
        piperTooSlow: false,
      }),
    ).toBe('kokoro');

    expect(
      resolveMp3Provider({
        deviceClass: 'laptop',
        voiceOrder: 'piper-first',
        kokoroReady: true,
        kokoroAllowed: true,
        kokoroTooSlow: false,
        piperReady: true,
        piperAllowed: true,
        piperTooSlow: false,
      }),
    ).toBe('piper');

    expect(
      resolveMp3Provider({
        deviceClass: 'laptop',
        voiceOrder: 'auto',
        kokoroReady: true,
        kokoroAllowed: true,
        kokoroTooSlow: true,
        piperReady: true,
        piperAllowed: true,
        piperTooSlow: false,
      }),
    ).toBe('piper');

    expect(
      resolveMp3Provider({
        deviceClass: 'phone',
        voiceOrder: 'auto',
        kokoroReady: false,
        kokoroAllowed: false,
        kokoroTooSlow: false,
        piperReady: false,
        piperAllowed: false,
        piperTooSlow: false,
      }),
    ).toBeNull();
  });
});

describe('MP3 encoding from Kokoro Float32 PCM and Piper 22050 Hz WAV', () => {
  it('parses WAV, stitches chunks with silence gaps, and encodes valid MP3 at 22050 Hz and 24000 Hz', async () => {
    const wav = buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 4410, amplitude: 6000 });
    const parsed = parsePcmWav(wav);
    expect(parsed.sampleRate).toBe(22050);
    expect(parsed.samples).toHaveLength(4410);

    const stitchedPiper = stitchPcmChunks([parsed, parsed], 200);
    const mp3Piper = encodeMonoMp3(stitchedPiper.samples, stitchedPiper.sampleRate);
    expect(mp3Piper.type).toBe('audio/mpeg');
    expect(mp3Piper.size).toBeGreaterThan(500);
    const piperBytes = new Uint8Array(await mp3Piper.arrayBuffer());
    expect(piperBytes[0]).toBe(0xff);

    const stitchedKokoro = stitchPcmChunks(
      [{ samples: buildToneSamples(24000, 0.3), sampleRate: 24000 }],
      200,
    );
    const mp3Kokoro = encodeMonoMp3(stitchedKokoro.samples, stitchedKokoro.sampleRate);
    expect(mp3Kokoro.type).toBe('audio/mpeg');
    expect(mp3Kokoro.size).toBeGreaterThan(500);
  });

  it('builds readable filenames from source photos or fallback dates', () => {
    expect(buildMp3Filename({ sourceName: 'Water_Cycle Diagram.jpg', mode: 'detail' })).toBe(
      'water-cycle-diagram-full-detail.mp3',
    );
    expect(buildMp3Filename({ sourceName: 'photo.jpg', mode: 'describe', createdAt: Date.UTC(2026, 10, 16, 12) })).toMatch(
      /^allhail-quick-look-2026-11-1[56]\.mp3$/,
    );
  });

  it('cleans speech text and exports via Kokoro or Piper client synthesizers', async () => {
    const kokoroTexts: string[] = [];
    const kokoroClient = new KokoroBrowserClient({
      synthesizer: {
        synthesizeChunk: vi.fn(async ({ text }) => {
          kokoroTexts.push(text);
          return { samples: buildToneSamples(24000, 0.2), sampleRate: 24000 };
        }),
        cancelJob: vi.fn(),
      },
    });
    const piperClient = new PiperBrowserClient({
      synthesizer: {
        synthesizeChunk: vi.fn(async () =>
          buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 4410, amplitude: 6000 }),
        ),
        cancelJob: vi.fn(),
      },
    });

    const progressUpdates: Array<[number, number]> = [];
    const kokoroMp3 = await exportSpeechToMp3({
      rawText: 'See *The Lake*. About 3/4 is blue. The trees stand quietly along the bank.',
      provider: 'kokoro',
      kokoroVoiceId: 'af_heart',
      speechRate: 1,
      kokoroClient,
      piperClient,
      onProgress: (done, total) => progressUpdates.push([done, total]),
    });
    expect(kokoroTexts.join(' ')).toContain('three quarters');
    expect(kokoroTexts.join(' ')).not.toContain('*');
    expect(kokoroMp3.provider).toBe('kokoro');
    expect(kokoroMp3.blob.type).toBe('audio/mpeg');
    expect(progressUpdates.at(-1)).toEqual([3, 3]);

    const piperMp3 = await exportSpeechToMp3({
      rawText: 'A clear worksheet page.',
      provider: 'piper',
      kokoroVoiceId: 'af_heart',
      speechRate: 1,
      kokoroClient,
      piperClient,
    });
    expect(piperMp3.provider).toBe('piper');
    expect(piperMp3.blob.size).toBeGreaterThan(500);
  });
});
