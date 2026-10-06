// Zips the extension folder into dist/inkflip-<version>.zip, ready for the Chrome Web Store.
// With --site it also copies the zip to site/download/inkflip.zip. The website never names a
// version, so its download link stays the same across releases.
import { readFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.error(`Version mismatch: manifest ${version}, package.json ${pkg.version}`);
  process.exit(1);
}
const out = path.join(root, 'dist', `inkflip-${version}.zip`);
await mkdir(path.dirname(out), { recursive: true });
await rm(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '*.DS_Store'], { cwd: path.join(root, 'extension') });
console.log(path.relative(root, out));

if (process.argv.includes('--site')) {
  const site = path.join(root, 'site/download/inkflip.zip');
  await mkdir(path.dirname(site), { recursive: true });
  await copyFile(out, site);
  console.log(path.relative(root, site));
}
