import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

// An alternate output keeps fixture previews separate from the selected runtime.
const outputDir = process.env.HOSTY_SPEECH_BUILD_DIR || 'dist';
await mkdir(outputDir, { recursive: true });
const styles = await postcss([tailwindcss()]).process(await readFile('styles.css', 'utf8'), {
  from: 'styles.css', to: join(outputDir, 'styles.css'), map: false,
});
await Promise.all([
  build({ entryPoints: ['server.ts'], outfile: join(outputDir, 'server.js'), bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external' }),
  build({ entryPoints: ['src/native-worker.ts'], outfile: join(outputDir, 'native-worker.js'), bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external' }),
  build({ entryPoints: ['client.tsx'], outfile: join(outputDir, 'client.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'esm', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } }),
  copyFile('index.html', join(outputDir, 'index.html')),
  writeFile(join(outputDir, 'styles.css'), styles.css),
]);
