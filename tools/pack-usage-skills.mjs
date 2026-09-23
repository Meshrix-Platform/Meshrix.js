import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillsRoot = path.join(repoRoot, "skills");
const outputRoot = path.join(repoRoot, "build", "usage-skills");

function frontmatterAudience(skill) {
  const block = skill.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!block) return null;
  return block.match(/^audience:\s*([^\n]+)$/m)?.[1]?.trim() ?? null;
}

const entries = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const usageSkills = [];
for (const name of entries) {
  const skillPath = path.join(skillsRoot, name, "SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  const audience = frontmatterAudience(skill);
  if (audience === "usage") usageSkills.push(name);
  else if (audience !== "development") {
    throw new Error(`${name}: audience must be exactly usage or development`);
  }
}

if (usageSkills.length === 0) {
  process.stderr.write("pack-usage-skills: zero usage skills\n");
  process.exitCode = 1;
  throw new Error("zero usage skills");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const name of usageSkills) {
  await cp(path.join(skillsRoot, name), path.join(outputRoot, name), {
    recursive: true,
    force: true,
  });
}

const manifest = {
  skills: usageSkills,
  count: usageSkills.length,
};
await writeFile(
  path.join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({ ok: true, output: "build/usage-skills", ...manifest }));
