// Package the extension into dist/adaptive-dark-mode-<version>.zip (runtime files only).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8'));
const out = path.join(repo, 'dist', `adaptive-dark-mode-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', '-X', out, 'manifest.json', 'src', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', '-x', '*.DS_Store'], { cwd: repo });
console.log(`${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
