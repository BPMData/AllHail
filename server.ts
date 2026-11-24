import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDescribeHandler, type DescribeDeps } from './server/describe.ts';
import { createReportHandler, MAX_REPORT_BODY, type ReportDeps } from './server/report.ts';
import { strings } from './shared/strings.ts';

const root = dirname(fileURLToPath(import.meta.url));

/** Serve the built app (not the Vite dev server) only when NODE_ENV is production. The deploy sets it. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export async function createApp({
  production = isProduction(),
  describeDeps,
  reportDeps,
}: {
  production?: boolean;
  describeDeps?: DescribeDeps;
  reportDeps?: ReportDeps;
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/describe', express.json({ limit: '6mb' }), createDescribeHandler(describeDeps));
  app.post('/api/report', express.json({ limit: MAX_REPORT_BODY }), createReportHandler(reportDeps));
  // Ensure malformed JSON or oversized bodies on /api return JSON instead of HTML.
  app.use('/api', (err: { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (req.path === '/report') {
      return res.status(400).json({ error: 'invalid_report', message: strings.errReportInvalid });
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'image_too_large', message: strings.errImageTooLarge });
    }
    return res.status(400).json({ error: 'invalid_request', message: strings.errInvalidRequest });
  });
  // Unknown API routes must never return the app HTML (or be cached offline).
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  if (production) {
    const dist = resolve(root, 'dist');
    if (!existsSync(resolve(dist, 'index.html'))) {
      throw new Error('Build the app with npm run build before starting production.');
    }
    app.use(express.static(dist, {
      setHeaders(res, filePath) {
        // Always revalidate HTML, manifests and workers when a new build is deployed.
        res.setHeader('Cache-Control', filePath.startsWith(resolve(dist, 'assets') + '/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      },
    }));
    app.get('*', (req, res, next) => {
      // Missing scripts/icons must be real 404s, never HTML with the wrong MIME type.
      if (req.path.includes('.') || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(dist, 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
    // Serve the single self-hosted JSEP ONNX variant, Piper phonemizer, and CREDITS directly from node_modules/root.
    const devRuntimeFiles = new Map<string, string>([
      ['/ort/ort-wasm-simd-threaded.jsep.mjs', resolve(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs')],
      ['/ort/ort-wasm-simd-threaded.jsep.wasm', resolve(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm')],
      ['/piper/piper_phonemize.wasm', resolve(root, 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm')],
      ['/piper/piper_phonemize.data', resolve(root, 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data')],
      ['/CREDITS.md', resolve(root, 'CREDITS.md')],
    ]);
    app.use((req, res, next) => {
      const target = devRuntimeFiles.get(req.path);
      if (!target) return next();
      return res.sendFile(target);
    });
    app.use(vite.middlewares);
  }

  return app;
}

function readCliFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

// Importing for checks/tests does not open a port. Production needs no TS loader.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const app = await createApp();
  const port = Number(readCliFlag(args, '--port') || process.env.PORT || 3000);
  const host = readCliFlag(args, '--host') || process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => console.log(`AllHail is listening on http://${host}:${port}`));
}
