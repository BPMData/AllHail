import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measurePiperDownloadSize, verifySingleOnnxRuntime } from './runtimeAssets.mjs';

const root = process.cwd();
const checkDist = existsSync(resolve(root, 'dist/assets'));
const result = verifySingleOnnxRuntime(root, { checkDist });
const size = measurePiperDownloadSize(root);

if (checkDist) {
  const swPath = resolve(root, 'dist/sw.js');
  if (existsSync(swPath)) {
    const sw = readFileSync(swPath, 'utf8');
    if (/ort-wasm-simd-threaded|piper_phonemize/.test(sw.split('precacheAndRoute')[1]?.split(']')[0] ?? '')) {
      throw new Error('Workbox precache manifest must not include /ort/ or /piper/ runtime binaries.');
    }
  }
}

console.log(
  `ONNX check passed: single onnxruntime-web ${result.version}; measured Piper total download ~${size.sizeMb} MB (${size.totalBytes} bytes).`,
);
