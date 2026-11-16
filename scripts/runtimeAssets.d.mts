export declare const PIPER_VOICE_ID: string;
export declare const PIPER_MODEL_BYTES: number;
export declare const PIPER_CONFIG_BYTES: number;
export declare const ORT_RUNTIME_FILES: string[];
export declare const PIPER_ORT_RUNTIME_FILES: string[];
export declare const PIPER_PHONEMIZE_FILES: string[];

export interface PiperSizeMeasurement {
  modelBytes: number;
  runtimeBytes: number;
  totalBytes: number;
  sizeMb: number;
}

export interface OnnxRuntimePackageEntry {
  path: string;
  version: string;
}

export interface VerifySingleOnnxRuntimeResult {
  version: string;
  locations: string[];
  distVersions: string[];
}

export interface VerifyDistRuntimeAssetsResult {
  ortFiles: string[];
  piperFiles: string[];
}

export declare function copySelfHostedRuntimesToDist(rootDir?: string): PiperSizeMeasurement;
export declare function measurePiperDownloadSize(rootDir?: string): PiperSizeMeasurement;
export declare function findOnnxRuntimeVersionsInNodeModules(
  rootDir?: string,
): OnnxRuntimePackageEntry[];
export declare function findOnnxRuntimeVersionStringsInDist(distDir: string): string[];
export declare function verifySingleOnnxRuntime(
  rootDir?: string,
  options?: { checkDist?: boolean },
): VerifySingleOnnxRuntimeResult;
export declare function verifyDistRuntimeAssets(rootDir?: string): VerifyDistRuntimeAssetsResult;
