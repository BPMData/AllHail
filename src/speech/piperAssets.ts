declare const __PIPER_DOWNLOAD_SIZE_MB__: number | undefined;

export const PIPER_VOICE_ID = 'en_US-hfc_female-medium' as const;

// Point Piper at the single shipped JSEP ONNX WASM variant so one binary serves both Kokoro and Piper.
export const PIPER_WASM_PATHS = {
  onnxWasm: {
    mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs',
    wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm',
  },
  piperWasm: '/piper/piper_phonemize.wasm',
  piperData: '/piper/piper_phonemize.data',
} as const;

export const PIPER_RUNTIME_CACHE_NAME = 'allhail-piper-runtime';

export const PIPER_RUNTIME_FILES = [
  '/ort/ort-wasm-simd-threaded.jsep.mjs',
  '/ort/ort-wasm-simd-threaded.jsep.wasm',
  '/piper/piper_phonemize.wasm',
  '/piper/piper_phonemize.data',
] as const;

export const PIPER_TOTAL_SIZE_MB =
  typeof __PIPER_DOWNLOAD_SIZE_MB__ === 'number' && Number.isFinite(__PIPER_DOWNLOAD_SIZE_MB__)
    ? __PIPER_DOWNLOAD_SIZE_MB__
    : 104;

export async function warmPiperRuntimeCache({
  cacheStorage = typeof caches !== 'undefined' ? caches : undefined,
  fetchFn = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined,
  files = PIPER_RUNTIME_FILES,
  onProgress,
}: {
  cacheStorage?: CacheStorage;
  fetchFn?: typeof fetch;
  files?: readonly string[];
  onProgress?: (fraction: number) => void;
} = {}): Promise<void> {
  if (!cacheStorage || !fetchFn || files.length === 0) {
    onProgress?.(1);
    return;
  }

  const cache = await cacheStorage.open(PIPER_RUNTIME_CACHE_NAME);
  for (let i = 0; i < files.length; i += 1) {
    const url = files[i];
    const existing = await cache.match(url);
    if (!existing) {
      const response = await fetchFn(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch Piper runtime asset ${url} (${response.status})`);
      }
      await cache.put(url, response.clone());
    }
    onProgress?.((i + 1) / files.length);
  }
}
