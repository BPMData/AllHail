import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { measurePiperDownloadSize } from './scripts/runtimeAssets.mjs';

const measuredPiperSize = measurePiperDownloadSize(process.cwd());
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

export default defineConfig({
  define: {
    // Shown in problem reports so the team knows which build someone is using.
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __PIPER_DOWNLOAD_SIZE_MB__: JSON.stringify(measuredPiperSize.sizeMb),
  },
  plugins: [react(), VitePWA({ manifest: false, injectRegister: false })],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'shared/**/*.test.ts', 'tests/*.test.ts'],
    restoreMocks: true,
  },
});
