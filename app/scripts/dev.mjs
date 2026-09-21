/** Start Vite, then Electron pointed at it. */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const vite = await createServer({ configFile: 'vite.config.ts' });
await vite.listen();
const url = vite.resolvedUrls?.local?.[0] ?? `http://localhost:${vite.config.server.port}/`;

await new Promise((r) => setTimeout(r, 300));

spawn('node', ['scripts/build-main.mjs', '--dev'], { stdio: 'inherit' })
  .on('exit', () => {
    const electron = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron', '.'],
      { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } },
    );
    electron.on('exit', () => { void vite.close(); process.exit(0); });
  });
