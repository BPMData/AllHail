import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOnnxRuntimeVersionsInNodeModules,
  measurePiperDownloadSize,
  verifySingleOnnxRuntime,
} from '../scripts/runtimeAssets.mjs';
import { PIPER_TOTAL_SIZE_MB } from '../src/speech/piperAssets.ts';

describe('single onnxruntime-web and PWA runtime precache exclusion', () => {
  it('installs strictly one onnxruntime-web version matching @huggingface/transformers', () => {
    const root = resolve(process.cwd());
    const versions = findOnnxRuntimeVersionsInNodeModules(root);
    const uniqueVersions = [...new Set(versions.map((v) => v.version))];
    expect(uniqueVersions).toEqual(['1.22.0-dev.20250409-89f8206ba4']);
    expect(() => verifySingleOnnxRuntime(root, { checkDist: false })).not.toThrow();
  });

  it('excludes /ort/ and /piper/ from Workbox precache while caching them on demand in allhail-piper-runtime', () => {
    const viteConfigText = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfigText).toContain("globIgnores: ['ort/**', 'piper/**']");
    expect(viteConfigText).toContain('maximumFileSizeToCacheInBytes: 6 * 1024 * 1024');
    expect(viteConfigText).toContain("cacheName: 'allhail-piper-runtime'");
    expect(viteConfigText).toContain("handler: 'CacheFirst'");

    const swPath = resolve(process.cwd(), 'dist/sw.js');
    if (existsSync(swPath)) {
      const swText = readFileSync(swPath, 'utf8');
      const precachePart = swText.split('precacheAndRoute')[1]?.split(']')[0] ?? '';
      expect(precachePart).not.toMatch(/ort-wasm|piper_phonemize|\/ort\/|\/piper\//);
    }
  });

  it('measures real combined Piper download size (model + ONNX/phonemize runtimes)', () => {
    const measured = measurePiperDownloadSize(process.cwd());
    expect(measured.runtimeBytes).toBeGreaterThan(20_000_000);
    expect(measured.modelBytes).toBeGreaterThan(60_000_000);
    expect(measured.sizeMb).toBe(PIPER_TOTAL_SIZE_MB);
    expect(measured.sizeMb).toBeGreaterThan(80);
  });
});
