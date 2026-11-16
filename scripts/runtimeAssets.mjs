import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PIPER_VOICE_ID = 'en_US-hfc_female-medium';
export const PIPER_MODEL_BYTES = 63_201_294;
export const PIPER_CONFIG_BYTES = 5_000;

// Ship one ONNX WASM variant only: it handles both WebGPU (Kokoro) and plain WASM (Piper).
export const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

export const PIPER_ORT_RUNTIME_FILES = [...ORT_RUNTIME_FILES];

export const PIPER_PHONEMIZE_FILES = [
  'piper_phonemize.wasm',
  'piper_phonemize.data',
];

export function copySelfHostedRuntimesToDist(rootDir = process.cwd()) {
  const ortSrcDir = resolve(rootDir, 'node_modules/onnxruntime-web/dist');
  const piperSrcDir = resolve(rootDir, 'node_modules/@diffusionstudio/piper-wasm/build');
  const distDir = resolve(rootDir, 'dist');
  const ortDestDir = join(distDir, 'ort');
  const piperDestDir = join(distDir, 'piper');

  if (!existsSync(ortSrcDir)) {
    throw new Error(`Missing onnxruntime-web dist directory at ${ortSrcDir}`);
  }
  if (!existsSync(piperSrcDir)) {
    throw new Error(`Missing @diffusionstudio/piper-wasm build directory at ${piperSrcDir}`);
  }

  mkdirSync(ortDestDir, { recursive: true });
  mkdirSync(piperDestDir, { recursive: true });

  // Remove any non-JSEP or stale ONNX files from dist/ort.
  for (const existing of readdirSync(ortDestDir)) {
    if (!ORT_RUNTIME_FILES.includes(existing)) {
      rmSync(join(ortDestDir, existing), { force: true, recursive: true });
    }
  }

  for (const file of ORT_RUNTIME_FILES) {
    const src = join(ortSrcDir, file);
    if (!existsSync(src)) {
      throw new Error(`Missing ONNX Runtime file: ${src}`);
    }
    copyFileSync(src, join(ortDestDir, file));
  }

  for (const file of PIPER_PHONEMIZE_FILES) {
    const src = join(piperSrcDir, file);
    if (!existsSync(src)) {
      throw new Error(`Missing Piper phonemize file: ${src}`);
    }
    copyFileSync(src, join(piperDestDir, file));
  }

  const creditsSrc = resolve(rootDir, 'CREDITS.md');
  if (existsSync(creditsSrc)) {
    copyFileSync(creditsSrc, join(distDir, 'CREDITS.md'));
  }

  return measurePiperDownloadSize(rootDir);
}

export function measurePiperDownloadSize(rootDir = process.cwd()) {
  const ortSrcDir = resolve(rootDir, 'node_modules/onnxruntime-web/dist');
  const piperSrcDir = resolve(rootDir, 'node_modules/@diffusionstudio/piper-wasm/build');
  const ortDistDir = resolve(rootDir, 'dist/ort');
  const piperDistDir = resolve(rootDir, 'dist/piper');

  let runtimeBytes = 0;
  for (const file of PIPER_ORT_RUNTIME_FILES) {
    const p = existsSync(join(ortSrcDir, file)) ? join(ortSrcDir, file) : join(ortDistDir, file);
    runtimeBytes += statSync(p).size;
  }
  for (const file of PIPER_PHONEMIZE_FILES) {
    const p = existsSync(join(piperSrcDir, file)) ? join(piperSrcDir, file) : join(piperDistDir, file);
    runtimeBytes += statSync(p).size;
  }

  const totalBytes = PIPER_MODEL_BYTES + PIPER_CONFIG_BYTES + runtimeBytes;
  const sizeMb = Math.round(totalBytes / 1_000_000);
  return {
    modelBytes: PIPER_MODEL_BYTES + PIPER_CONFIG_BYTES,
    runtimeBytes,
    totalBytes,
    sizeMb,
  };
}

export function findOnnxRuntimeVersionsInNodeModules(rootDir = process.cwd()) {
  const nmDir = resolve(rootDir, 'node_modules');
  const found = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'onnxruntime-web') {
        const pkgPath = join(dir, entry.name, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          found.push({ path: pkgPath, version: String(pkg.version) });
        }
        const nestedNm = join(dir, entry.name, 'node_modules');
        if (existsSync(nestedNm)) walk(nestedNm);
      } else if (entry.name.startsWith('@')) {
        walk(join(dir, entry.name));
      } else if (entry.name === 'node_modules') {
        walk(join(dir, entry.name));
      } else {
        const nestedNm = join(dir, entry.name, 'node_modules');
        if (existsSync(nestedNm)) walk(nestedNm);
      }
    }
  }

  walk(nmDir);
  return found;
}

export function findOnnxRuntimeVersionStringsInDist(distDir) {
  const assetsDir = join(distDir, 'assets');
  if (!existsSync(assetsDir)) return [];

  const versions = new Set();
  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(assetsDir, file), 'utf8');
    // Match onnxruntime-web version stamps embedded by onnxruntime-web itself (exclude piper-tts-web's overridden CDN fallback string).
    const matches = text.matchAll(/(?:=|:)\s*["'](1\.(?:1[89]|[23]\d)\.\d+(?:-dev\.\d+-[a-f0-9]+)?)["']/g);
    for (const m of matches) {
      const idx = m.index ?? 0;
      const snippet = text.slice(Math.max(0, idx - 120), Math.min(text.length, idx + 120));
      if (/cdnjs\.cloudflare\.com\/ajax\/libs\/onnxruntime-web/.test(snippet)) continue;
      if (/onnxruntime|ort-wasm|ort\.env|InferenceSession|wasmPaths|version/i.test(snippet)) {
        versions.add(m[1]);
      }
    }
  }
  return [...versions];
}

export function verifySingleOnnxRuntime(rootDir = process.cwd(), { checkDist = true } = {}) {
  const pkgEntries = findOnnxRuntimeVersionsInNodeModules(rootDir);
  const pkgVersions = [...new Set(pkgEntries.map((entry) => entry.version))];
  if (pkgVersions.length !== 1) {
    throw new Error(
      `Expected exactly one onnxruntime-web version in node_modules, found ${pkgVersions.length}: ${JSON.stringify(pkgEntries)}`,
    );
  }

  let distVersions = [];
  const distDir = resolve(rootDir, 'dist');
  if (checkDist && existsSync(join(distDir, 'assets'))) {
    distVersions = findOnnxRuntimeVersionStringsInDist(distDir);
    // Built bundle should contain no mismatched onnxruntime-web version string.
    const foreignVersions = distVersions.filter((v) => v !== pkgVersions[0]);
    if (foreignVersions.length > 0) {
      throw new Error(
        `Multiple or mismatched onnxruntime-web versions found in dist/: expected ${pkgVersions[0]}, also found ${foreignVersions.join(', ')}`,
      );
    }
  }

  return {
    version: pkgVersions[0],
    locations: pkgEntries.map((e) => dirname(e.path)),
    distVersions,
  };
}

export function verifyDistRuntimeAssets(rootDir = process.cwd()) {
  const distDir = resolve(rootDir, 'dist');
  const ortDir = join(distDir, 'ort');
  const piperDir = join(distDir, 'piper');
  const assetsDir = join(distDir, 'assets');

  if (!existsSync(ortDir)) {
    throw new Error(`Missing built ONNX runtime directory at ${ortDir}`);
  }
  const actualOrtFiles = readdirSync(ortDir).sort();
  const expectedOrtFiles = [...ORT_RUNTIME_FILES].sort();
  if (
    actualOrtFiles.length !== expectedOrtFiles.length ||
    actualOrtFiles.some((file, index) => file !== expectedOrtFiles[index])
  ) {
    throw new Error(
      `Expected dist/ort to contain only ${expectedOrtFiles.join(', ')}, found: ${actualOrtFiles.join(', ')}`,
    );
  }

  if (!existsSync(piperDir)) {
    throw new Error(`Missing built Piper runtime directory at ${piperDir}`);
  }
  for (const file of PIPER_PHONEMIZE_FILES) {
    if (!existsSync(join(piperDir, file))) {
      throw new Error(`Missing built Piper file: ${join(piperDir, file)}`);
    }
  }

  if (existsSync(assetsDir)) {
    const duplicateOrtAssets = readdirSync(assetsDir).filter((file) =>
      /^ort-wasm.*\.(?:wasm|mjs)$/i.test(file),
    );
    if (duplicateOrtAssets.length > 0) {
      throw new Error(
        `Found duplicate ONNX WASM assets in dist/assets/: ${duplicateOrtAssets.join(', ')}`,
      );
    }
  }

  const swPath = join(distDir, 'sw.js');
  if (existsSync(swPath)) {
    const sw = readFileSync(swPath, 'utf8');
    if (/ort-wasm-simd-threaded|piper_phonemize/.test(sw.split('precacheAndRoute')[1]?.split(']')[0] ?? '')) {
      throw new Error('Workbox precache manifest must not include /ort/ or /piper/ runtime binaries.');
    }
  }

  return {
    ortFiles: actualOrtFiles,
    piperFiles: PIPER_PHONEMIZE_FILES,
  };
}
