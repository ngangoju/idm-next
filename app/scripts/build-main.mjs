/**
 * Bundle the main and preload processes.
 *
 * Electron's module loader does not strip TypeScript, and bundling also spares
 * us from shipping node_modules inside the app, so both entry points go through
 * esbuild. CommonJS output because the preload script must be CJS.
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const dev = process.argv.includes('--dev');

await rm('dist/main', { recursive: true, force: true });
await rm('dist/preload', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: dev,
  minify: !dev,
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
});

await build({
  ...common,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
});
