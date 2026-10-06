// Zips the extension folder into dist/inkflip-<version>.zip, ready for the Chrome Web Store.
import { readFile, mkdir, rm } from 'node:fs/promises';
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
