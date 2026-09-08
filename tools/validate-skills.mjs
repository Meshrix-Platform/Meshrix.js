import { access, readdir, readFile } from "node:fs/promises";

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

  if (!/^description:[ \t]*\S/m.test(skill)) throw new Error(`${name}: missing routing description`);

  for (const [, reference] of skill.matchAll(/\$([a-z0-9][a-z0-9-]*)/g)) {
    if ((reference === "meshrix-js" || reference.startsWith("meshrix-js-")) && !known.has(reference)) {
      throw new Error(`${name}: unknown local skill $${reference}`);
    }
  }

  const agent = await readFile(new URL(`${name}/agents/openai.yaml`, root), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (agent !== null && !agent.includes(`$${name}`)) {
    throw new Error(`${name}: agent prompt does not reference its skill`);
  }
}

let markdownCount = 0, referenceCount = 0;
const problems = [];
async function checkReferences(directory) {
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const relative = `${directory}${entry.name}`;
    if (entry.isDirectory()) { await checkReferences(relative + "/"); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    markdownCount += 1;
    const file = new URL(relative, root);
    const prose = (await readFile(file, "utf8")).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
    for (const [, reference] of prose.matchAll(/\$(meshrix-js(?:-[a-z0-9-]+)?)/g)) {
      if (!known.has(reference)) problems.push(`${relative}: unknown skill $${reference}`);
    }
    for (const [, target] of prose.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
      referenceCount += 1;
      try { await access(new URL(target.split("#")[0], file)); }
      catch { problems.push(`${relative}: missing reference ${target}`); }
    }
  }
}
await checkReferences("");
if (problems.length) throw new Error(problems.join("\n"));
console.log(JSON.stringify({ ok: true, skillCount: entries.length, markdownCount, referenceCount }));
