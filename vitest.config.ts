import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { measurePiperDownloadSize } from './scripts/runtimeAssets.mjs';

const measuredPiperSize = measurePiperDownloadSize(process.cwd());

export default defineConfig({
  define: {
    __PIPER_DOWNLOAD_SIZE_MB__: JSON.stringify(measuredPiperSize.sizeMb),
  },
  plugins: [react(), VitePWA({ manifest: false, injectRegister: false })],
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.{ts,tsx}',
      'server/**/*.test.ts',
      'shared/**/*.test.ts',
      'tests/*.test.ts',
    ],
    restoreMocks: true,
  },
});
