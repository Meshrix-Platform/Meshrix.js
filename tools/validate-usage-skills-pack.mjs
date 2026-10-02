/**
 * Validates the packed usage-skills tree (build/usage-skills) in isolation.
 * $meshrix-js-* references that point at development-only skills are allowed
 * as full-checkout documentation pointers; missing relative files still fail.
 */
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packRoot = path.join(repoRoot, "build", "usage-skills");

const packedEntries = (await readdir(packRoot, { withFileTypes: true }).catch(() => {
  throw new Error("build/usage-skills missing; run npm run pack:usage-skills first");
}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (packedEntries.length === 0) throw new Error("usage skills pack is empty");

const packed = new Set(packedEntries);

const manifest = JSON.parse(await readFile(path.join(packRoot, "manifest.json"), "utf8"));
if (!Array.isArray(manifest.skills) || manifest.count !== manifest.skills.length) {
  throw new Error("manifest.json skills/count mismatch");
}
if (manifest.count !== packedEntries.length) {
  throw new Error(`manifest count ${manifest.count} != packed dirs ${packedEntries.length}`);
}
for (const name of manifest.skills) {
  if (!packed.has(name)) throw new Error(`manifest lists missing skill ${name}`);
}

if (!Array.isArray(manifest.developmentSkills) || manifest.developmentSkills.some((name) => typeof name !== "string" || !/^meshrix-js(?:-[a-z0-9-]+)?$/.test(name) || packed.has(name))) {
  throw new Error("manifest.json developmentSkills must list development-only documentation pointers");
}
const developmentPointers = new Set(manifest.developmentSkills);

const problems = [];
for (const name of packedEntries) {
  const skill = await readFile(path.join(packRoot, name, "SKILL.md"), "utf8");
  const audience = skill.match(/^audience:\s*([^\n]+)$/m)?.[1]?.trim();
  if (audience !== "usage") problems.push(`${name}: packed skill audience is ${audience ?? "missing"}`);
  const declared = skill.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  if (declared !== name) problems.push(`${name}: frontmatter name is ${declared ?? "missing"}`);
}

async function checkMarkdown(directory, baseUrl) {
  for (const entry of await readdir(path.join(baseUrl, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    const absolute = path.join(baseUrl, relative);
    if (entry.isDirectory()) {
      await checkMarkdown(relative, baseUrl);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const prose = (await readFile(absolute, "utf8")).replace(
      /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm,
      "",
    );
    for (const [, reference] of prose.matchAll(/\$(meshrix-js(?:-[a-z0-9-]+)?)/g)) {
      if (packed.has(reference)) continue;
      if (developmentPointers.has(reference)) continue; // explicit full-checkout documentation pointer
      problems.push(`${relative}: unknown skill $${reference}`);
    }
    for (const [, target] of prose.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
      const targetPath = target.split("#")[0];
      const destination = path.resolve(path.dirname(absolute), targetPath);
      const withinPack = path.relative(packRoot, destination);
      if (withinPack.startsWith(`..${path.sep}`) || withinPack === ".." || path.isAbsolute(withinPack)) {
        problems.push(`${relative}: reference escapes the usage pack ${target}`);
        continue;
      }
      try {
        await access(destination);
      } catch {
        problems.push(`${relative}: missing reference ${target}`);
      }
    }
  }
}

await checkMarkdown("", packRoot);
if (problems.length) throw new Error(problems.join("\n"));
console.log(JSON.stringify({ ok: true, skillCount: packedEntries.length, count: manifest.count }));
