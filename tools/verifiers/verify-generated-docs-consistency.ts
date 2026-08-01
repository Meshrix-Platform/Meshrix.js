#!/usr/bin/env node
/**
 * verify-generated-docs-consistency.ts — validates registry-governed docs.
 *
 * docs.registry.json is the single metadata source for generatedAt and source
 * ownership. Markdown files should not duplicate that metadata as a second fact.
 */
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname: any = dirname(fileURLToPath(import.meta.url));
const ROOT: any = resolve(__dirname, '..', '..');
const docsRegistry: any = JSON.parse(
  await readFile(resolve(ROOT, 'tools/registry/docs.registry.json'), 'utf8')
);
const EXPECTED_DOCS: any = (docsRegistry.entries || []).map((entry?: any) : any => ({
  id: entry.id,
  path: entry.path,
  source: entry.source,
}));

let failed: any = 0;
let ok: any = 0;
let checked: any = 0;

function dateAccepted(value: any = '') : any {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

async function pathExists(filePath?: any) : Promise<any> {
  try {
    await access(resolve(ROOT, filePath));
    return true;
  } catch {
    return false;
  }
}

if (!dateAccepted(docsRegistry.generatedAt)) {
  console.error('  ✗ tools/registry/docs.registry.json: missing or invalid generatedAt metadata');
  failed++;
} else {
  ok++;
}
checked++;

for (const doc of EXPECTED_DOCS) {
  const docPath: any = resolve(ROOT, doc.path);
  try {
    await access(docPath);
    const content: any = await readFile(docPath, 'utf8');
    const sourceAccepted: any = /^[a-z]+:\/\//i.test(doc.source) || await pathExists(doc.source);
    const verificationSectionAccepted: any = !doc.path.startsWith('docs/functionality/') || /^## Verification\b/mu.test(content);
    const executableVerificationAccepted: any = !doc.path.startsWith('docs/functionality/') ||
      /```bash[\s\S]*?\b(?:npm|node)\s+/u.test(content);

    if (!sourceAccepted) {
      console.error(`  ✗ ${doc.path}: registry source is missing: ${doc.source}`);
      failed++;
    } else if (!verificationSectionAccepted) {
      console.error(`  ✗ ${doc.path}: missing Verification section`);
      failed++;
    } else if (!executableVerificationAccepted) {
      console.error(`  ✗ ${doc.path}: missing executable verification commands`);
      failed++;
    } else {
      ok++;
    }
  } catch {
    console.error(`  ✗ ${doc.path}: missing generated doc`);
    failed++;
  }
  checked++;
}

console.log(`\nGenerated docs consistency: ${ok}/${checked} OK, ${failed} with issues`);

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
