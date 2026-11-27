import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  copySelfHostedRuntimesToDist,
  measurePiperDownloadSize,
  verifyDistRuntimeAssets,
  verifySingleOnnxRuntime,
} from './scripts/runtimeAssets.mjs';
import { strings } from './shared/strings.ts';

const initialPiperSize = measurePiperDownloadSize(process.cwd());
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

function dedupeSelfHostedOnnxWasm() {
  return {
    name: 'allhail-dedupe-onnx-wasm',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; fileName: string; code?: string }>) {
      const removedAssets: string[] = [];
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && /^assets\/ort-wasm-simd-threaded.*\.(?:wasm|mjs)$/.test(key)) {
          removedAssets.push(key);
          delete bundle[key];
        }
      }
      if (removedAssets.length > 0) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'chunk' && typeof item.code === 'string') {
            for (const assetPath of removedAssets) {
              const target = assetPath.endsWith('.mjs')
                ? '/ort/ort-wasm-simd-threaded.jsep.mjs'
                : '/ort/ort-wasm-simd-threaded.jsep.wasm';
              item.code = item.code.replaceAll(`/${assetPath}`, target);
            }
          }
        }
      }
    },
  };
}

export default defineConfig({
  define: {
    // Shown in problem reports so the team knows which build someone is using.
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __PIPER_DOWNLOAD_SIZE_MB__: JSON.stringify(initialPiperSize.sizeMb),
  },
  worker: {
    format: 'es',
    plugins: () => [dedupeSelfHostedOnnxWasm()],
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    hmr: false,
  },
  plugins: [
    dedupeSelfHostedOnnxWasm(),
    {
      name: 'allhail-self-hosted-runtimes',
      configureServer() {
        verifySingleOnnxRuntime(process.cwd(), { checkDist: false });
      },
      buildStart() {
        verifySingleOnnxRuntime(process.cwd(), { checkDist: false });
      },
      closeBundle() {
        copySelfHostedRuntimesToDist(process.cwd());
        verifySingleOnnxRuntime(process.cwd(), { checkDist: true });
        verifyDistRuntimeAssets(process.cwd());
      },
    },
    react(),
    tailwindcss(),
    {
      name: 'allhail-html-strings',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) =>
          html
            .replaceAll('%APP_LANGUAGE%', strings.language)
            .replaceAll('%APP_NAME%', strings.appName)
            .replaceAll('%APP_DESCRIPTION%', strings.description)
            .replaceAll('%APP_NO_SCRIPT%', strings.noScript),
      },
    },
    VitePWA({
      // Ask before updating, so future speech jobs and edits aren't interrupted.
      registerType: 'prompt',
      includeAssets: ['icons/*'],
      manifest: {
        id: '/',
        name: strings.appName,
        short_name: strings.appName,
        description: strings.description,
        lang: strings.language,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fbf9f9',
        theme_color: '#6e1d20',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,ttf}'],
        globIgnores: ['ort/**', 'piper/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/(?:ort|piper)(?:\/|$)/, /^\/CREDITS\.md$/],
        // Cache self-hosted /ort/ and /piper/ files strictly on demand, never on initial install.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/piper/') || url.pathname.startsWith('/ort/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'allhail-piper-runtime',
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
});
