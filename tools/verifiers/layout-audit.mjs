#!/usr/bin/env node
/**
 * layout-audit.mjs — Stable command entry for the layout audit verifier.
 *
 * Usage:
 *   node tools/verifiers/layout-audit.mjs --strict --format json
 *   node tools/verifiers/layout-audit.mjs --report-only --format json
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const auditScript = resolve(ROOT, 'tools/server-scripts/verify-layout-audit.mjs');
const args = process.argv.slice(2);

const proc = spawn(process.execPath, [auditScript, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
});

proc.on('close', (code) => {
  process.exit(code || 0);
});

proc.on('error', (err) => {
  console.error('layout-audit: Failed to spawn verifier:', err.message);
  process.exit(1);
});
