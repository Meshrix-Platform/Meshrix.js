import { readdir, readFile } from "node:fs/promises";

const root = new URL("../skills/", import.meta.url);
const entries = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (entries.length === 0) throw new Error("skills directory is empty");

const known = new Set(entries);
for (const name of entries) {
  const skill = await readFile(new URL(`${name}/SKILL.md`, root), "utf8");
  const declared = skill.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  if (declared !== name) {
    throw new Error(`${name}: frontmatter name is ${declared ?? "missing"}`);
  }

  for (const [, reference] of skill.matchAll(/\$([a-z0-9][a-z0-9-]*)/g)) {
    if (reference.startsWith("meshrix-js-") && !known.has(reference)) {
      throw new Error(`${name}: unknown local skill $${reference}`);
    }
  }

  const agent = await readFile(new URL(`${name}/agents/openai.yaml`, root), "utf8");
  if (!agent.includes(`$${name}`)) {
    throw new Error(`${name}: agent prompt does not reference its skill`);
  }
}

console.log(JSON.stringify({ ok: true, skillCount: entries.length }));
