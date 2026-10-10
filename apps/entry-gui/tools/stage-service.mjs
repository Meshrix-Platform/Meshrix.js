/**
 * Stage the compiled backend service bundle into src-tauri/resources/service/
 * so `tauri build` picks it up via `bundle.resources`. Run after
 * `build:service` (the `dist`/`pack:dir` scripts chain both).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "service");
mkdirSync(target, { recursive: true });
copyFileSync(join(root, "dist", "service", "entry-service.mjs"), join(target, "entry-service.mjs"));
console.log(`staged service bundle → ${target}`);
