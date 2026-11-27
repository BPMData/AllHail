import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { measurePiperDownloadSize, verifyDistRuntimeAssets, verifySingleOnnxRuntime } from './runtimeAssets.mjs';

const root = process.cwd();
const checkDist = existsSync(resolve(root, 'dist/assets'));
const result = verifySingleOnnxRuntime(root, { checkDist });
const size = measurePiperDownloadSize(root);

if (checkDist) {
  verifyDistRuntimeAssets(root);
}

console.log(
  `ONNX check passed: single onnxruntime-web ${result.version} (.jsep only); measured Piper total download ~${size.sizeMb} MB (${size.totalBytes} bytes).`
);
