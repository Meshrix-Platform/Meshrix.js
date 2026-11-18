#!/usr/bin/env node
/**
 * layout-audit.ts — Stable command entry for the layout audit verifier.
 *
 * Usage:
 *   node tools/verifiers/layout-audit.ts --strict --format json
 *   node tools/verifiers/layout-audit.ts --report-only --format json
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname: any = dirname(fileURLToPath(import.meta.url));
const ROOT: any = resolve(__dirname, '..', '..');

const auditScript: any = resolve(ROOT, 'tools/server-scripts/verify-layout-audit.ts');
const args: any = process.argv.slice(2);

const proc: any = spawn(process.execPath, [auditScript, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
});

proc.on('close', (code?: any) : any => {
  process.exit(code || 0);
});

proc.on('error', (err?: any) : any => {
  console.error('layout-audit: Failed to spawn verifier:', err.message);
  process.exit(1);
});
