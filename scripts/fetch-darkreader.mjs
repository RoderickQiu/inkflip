// Downloads Dark Reader's latest Manifest V3 build into test/.cache/darkreader, so the
// end-to-end test can run Inkflip next to it.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(root, 'test/.cache');
const url = 'https://github.com/darkreader/darkreader/releases/latest/download/darkreader-chrome-mv3.zip';
await mkdir(dir, { recursive: true });
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const zip = path.join(dir, 'darkreader.zip');
await writeFile(zip, Buffer.from(await res.arrayBuffer()));
await rm(path.join(dir, 'darkreader'), { recursive: true, force: true });
execFileSync('unzip', ['-q', '-o', zip, '-d', path.join(dir, 'darkreader')]);
console.log('Dark Reader unpacked into test/.cache/darkreader');
