import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(project, 'dist');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
const cssPath = html.match(/href="\.\/(assets\/[^\"]+\.css)"/)?.[1];
const jsPath = html.match(/src="\.\/(assets\/[^\"]+\.js)"/)?.[1];
if (!cssPath || !jsPath) throw new Error('Built CSS or JavaScript asset was not found.');
const [css, javascript] = await Promise.all([
  readFile(resolve(dist, cssPath), 'utf8'),
  readFile(resolve(dist, jsPath), 'utf8')
]);
html = html
  .replace(/<link rel="stylesheet"[^>]+>/, () => `<style>${css}</style>`)
  .replace(/<script type="module"[^>]+><\/script>/, () => `<script type="module">${javascript.replaceAll('</script', '<\\/script')}</script>`)
  .replace(/\s*<link rel="icon"[^>]+>/, '');
await writeFile(resolve(project, 'Offline_Dashboard.html'), html, 'utf8');
console.log('Created Offline_Dashboard.html');
