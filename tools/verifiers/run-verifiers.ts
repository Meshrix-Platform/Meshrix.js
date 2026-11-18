#!/usr/bin/env node
/**
 * run-verifiers.ts — Profile-based verifier runner.
 *
 * Usage:
 *   node tools/verifiers/run-verifiers.ts --profile required
 *   node tools/verifiers/run-verifiers.ts --profile architecture
 *   node tools/verifiers/run-verifiers.ts --profile security
 *   node tools/verifiers/run-verifiers.ts --profile hygiene
 *   node tools/verifiers/run-verifiers.ts --profile registry
 *   node tools/verifiers/run-verifiers.ts --profile docs
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname: any = dirname(fileURLToPath(import.meta.url));
const ROOT: any = resolve(__dirname, '..', '..');

const PROFILES: Record<string, any> = {
  required: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.ts'] },
    { label: 'registry validation', cmd: 'node', args: ['tools/verifiers/registry-validator.ts'] },
    { label: 'architecture graph', cmd: 'node', args: ['tools/verifiers/architecture-graph.ts'] },
    { label: 'layout audit', cmd: 'node', args: ['tools/server-scripts/verify-layout-audit.ts', '--strict', '--format', 'json'] },
  ],
  architecture: [
    { label: 'architecture graph', cmd: 'node', args: ['tools/verifiers/architecture-graph.ts'] },
    { label: 'layout audit', cmd: 'node', args: ['tools/verifiers/layout-audit.ts', '--strict'] },
  ],
  security: [
    { label: 'secret hygiene', cmd: 'node', args: ['tests/verify-secret-hygiene.ts'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.ts'] },
    { label: 'npm audit', cmd: 'npm', args: ['audit', '--audit-level=high', '--omit=dev'] },
    { label: 'security hardening', cmd: 'npm', args: ['run', 'server:verify:security-hardening'] },
  ],
  hygiene: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.ts'] },
    { label: 'root hygiene', cmd: 'node', args: ['tests/verify-root-hygiene.ts'] },
    { label: 'secret hygiene', cmd: 'node', args: ['tests/verify-secret-hygiene.ts'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.ts'] },
    { label: 'script registry', cmd: 'node', args: ['tests/verify-script-registry.ts'] },
    { label: 'frontend route registry', cmd: 'node', args: ['tests/verify-frontend-route-registry.ts'] },
  ],
  registry: [
    { label: 'registry validator', cmd: 'node', args: ['tools/verifiers/registry-validator.ts'] },
    { label: 'script registry', cmd: 'node', args: ['tests/verify-script-registry.ts'] },
    { label: 'test suite scripts', cmd: 'node', args: ['tests/verify-test-suite-scripts.ts'] },
  ],
  docs: [
    { label: 'boundary hygiene', cmd: 'node', args: ['tools/server-scripts/verify-public-boundary.ts'] },
    { label: 'registry validator', cmd: 'node', args: ['tools/verifiers/registry-validator.ts'] },
    { label: 'registry-governed docs consistency', cmd: 'node', args: ['tools/verifiers/verify-generated-docs-consistency.ts'] },
    { label: 'local-info high-risk gate', cmd: 'node', args: ['tools/config-scanner.ts'] },
  ],
};

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = { profile: 'required' };
  for (let i: any = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && argv[i + 1]) {
      args.profile = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function runProfile(profileName?: any) : Promise<any> {
  const steps: any = PROFILES[profileName];
  if (!steps) {
    console.error(`Unknown profile: ${profileName}. Valid: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  let failed: any = 0;
  for (const step of steps) {
    console.log(`\n[verify:${profileName}] ${step.label}`);
    try {
      await new Promise((resolve?: any, reject?: any) : any => {
        const env: Record<string, any> = { ...process.env };
        // npm exposes package allowScripts policy as a project-scoped CLI
        // setting to nested npm processes. Current npm rejects that setting
        // before `npm audit` can inspect the lockfile, so rely on the checked-in
        // package policy and do not forward the synthesized CLI value.
        delete env.npm_config_allow_scripts;
        const proc: any = spawn(step.cmd, step.args, {
          cwd: ROOT,
          env,
          stdio: 'inherit',
          shell: false
        });
        proc.on('close', (code?: any) : any => {
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
        proc.on('error', reject);
      });
      console.log(`  ✓ ${step.label}`);
    } catch (err: any) {
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

const args: any = parseArgs(process.argv.slice(2));
runProfile(args.profile).catch((err?: any) : any => {
  console.error(`[verify] FATAL:`, err.message);
  process.exit(1);
});
