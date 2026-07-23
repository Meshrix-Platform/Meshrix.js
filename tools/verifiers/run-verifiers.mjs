#!/usr/bin/env node
/**
 * run-verifiers.mjs — Profile-based verifier runner.
 *
 * Usage:
 *   node tools/verifiers/run-verifiers.mjs --profile required
 *   node tools/verifiers/run-verifiers.mjs --profile architecture
 *   node tools/verifiers/run-verifiers.mjs --profile security
 *   node tools/verifiers/run-verifiers.mjs --profile hygiene
 *   node tools/verifiers/run-verifiers.mjs --profile registry
 *   node tools/verifiers/run-verifiers.mjs --profile docs
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const PROFILES = {
  required: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.mjs'] },
    { label: 'registry validation', cmd: 'node', args: ['tools/verifiers/registry-validator.mjs'] },
    { label: 'architecture graph', cmd: 'node', args: ['tools/verifiers/architecture-graph.mjs'] },
    { label: 'layout audit', cmd: 'node', args: ['tools/server-scripts/verify-layout-audit.mjs', '--strict', '--format', 'json'] },
  ],
  architecture: [
    { label: 'architecture graph', cmd: 'node', args: ['tools/verifiers/architecture-graph.mjs'] },
    { label: 'layout audit', cmd: 'node', args: ['tools/verifiers/layout-audit.mjs', '--strict'] },
  ],
  security: [
    { label: 'secret hygiene', cmd: 'node', args: ['tests/verify-secret-hygiene.mjs'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.mjs'] },
    { label: 'npm audit', cmd: 'npm', args: ['audit', '--audit-level=high', '--omit=dev'] },
    { label: 'security hardening', cmd: 'npm', args: ['run', 'server:verify:security-hardening'] },
  ],
  hygiene: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.mjs'] },
    { label: 'root hygiene', cmd: 'node', args: ['tests/verify-root-hygiene.mjs'] },
    { label: 'secret hygiene', cmd: 'node', args: ['tests/verify-secret-hygiene.mjs'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.mjs'] },
    { label: 'script registry', cmd: 'node', args: ['tests/verify-script-registry.mjs'] },
    { label: 'frontend route registry', cmd: 'node', args: ['tests/verify-frontend-route-registry.mjs'] },
  ],
  registry: [
    { label: 'registry validator', cmd: 'node', args: ['tools/verifiers/registry-validator.mjs'] },
    { label: 'script registry', cmd: 'node', args: ['tests/verify-script-registry.mjs'] },
    { label: 'test suite scripts', cmd: 'node', args: ['tests/verify-test-suite-scripts.mjs'] },
  ],
  docs: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.mjs'] },
    { label: 'registry validator', cmd: 'node', args: ['tools/verifiers/registry-validator.mjs'] },
    { label: 'registry-governed docs consistency', cmd: 'node', args: ['tools/verifiers/verify-generated-docs-consistency.mjs'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.mjs'] },
  ],
};

function parseArgs(argv) {
  const args = { profile: 'required' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && argv[i + 1]) {
      args.profile = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function runProfile(profileName) {
  const steps = PROFILES[profileName];
  if (!steps) {
    console.error(`Unknown profile: ${profileName}. Valid: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  let failed = 0;
  for (const step of steps) {
    console.log(`\n[verify:${profileName}] ${step.label}`);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit', shell: false });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
        proc.on('error', reject);
      });
      console.log(`  ✓ ${step.label}`);
    } catch (err) {
      console.error(`  ✗ ${step.label}: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n[verify:${profileName}] ${failed}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`\n[verify:${profileName}] All ${steps.length} steps passed`);
}

const args = parseArgs(process.argv.slice(2));
runProfile(args.profile).catch((err) => {
  console.error(`[verify] FATAL:`, err.message);
  process.exit(1);
});
