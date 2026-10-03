import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The repository declares the Node.js runtimes it supports in `package.json` engines.
 *
 * Native modules are compiled per Node ABI, so running a verification entry on an
 * unsupported runtime fails inside product tests and reads as a product defect. The
 * entries therefore refuse before doing work, naming the supported range and the
 * observed runtime, instead of letting suites fail for an unrelated reason.
 */

export interface NodeRuntimeSupport {
  supported: boolean;
  /** Declared `engines.node`. An empty string means the repository declares no constraint. */
  engine: string;
  /** Observed runtime version without the leading `v`. */
  version: string;
  /** Node module ABI of the observed runtime. */
  modules: string;
}

/** Comparator forms the repository engine expression uses: `>=`, `>`, `<=`, `<`, `=` or a bare version. */
const COMPARATOR: RegExp = /^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/u;

export function readDeclaredNodeEngine(rootDir: string): string {
  const manifestPath: string = path.join(rootDir, "package.json");
  if (!existsSync(manifestPath)) return "";
  try {
    const manifest: any = JSON.parse(readFileSync(manifestPath, "utf8"));
    return String(manifest?.engines?.node || "").trim();
  } catch {
    return "";
  }
}

/**
 * Whether a runtime version satisfies an `engines` range. The range is a disjunction of
 * whitespace-separated comparators, matching the expression form the repository uses
 * (`>=22.19.0 <23 || >=24.3.0 <25`). A blank range declares no constraint.
 */
export function satisfiesNodeEngine(version: string, engine: string): boolean {
  const observed: number[] = versionTuple(version);
  if (observed.length !== 3) return false;
  const clauses: string[] = String(engine || "").split("||").map((clause: string) : any => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.some((clause: string) : any =>
    clause.split(/\s+/u).every((token: string) : any => comparatorMatches(observed, token)));
}

export function resolveNodeRuntimeSupport(
  { rootDir, version, modules }: { rootDir: string; version: string; modules: string }
): NodeRuntimeSupport {
  const engine: string = readDeclaredNodeEngine(rootDir);
  return {
    supported: satisfiesNodeEngine(version, engine),
    engine,
    version: String(version || "").replace(/^v/u, ""),
    modules: String(modules || "")
  };
}

/** A refusal that names the declared range, the observed runtime and why the difference matters. */
export function describeUnsupportedNodeRuntime(support: NodeRuntimeSupport): string {
  return [
    "Unsupported Node.js runtime: refusing to run, because an unsupported runtime fails",
    "inside product tests and reads as a product defect.",
    `  supported (package.json engines.node): ${support.engine || "<none declared>"}`,
    `  observed: node ${support.version} (modules ABI ${support.modules})`,
    "Native modules such as better-sqlite3 are compiled for a single Node ABI.",
    "Install a supported Node.js version and run this entry again."
  ].join("\n");
}

function comparatorMatches(observed: readonly number[], token: string): boolean {
  const match: RegExpMatchArray | null = token.match(COMPARATOR);
  if (!match) return false;
  const expected: number[] = versionTuple(match[2]);
  if (expected.length !== 3) return false;
  const comparison: number = compareTuples(observed, expected);
  const operator: string = match[1] || "=";
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function compareTuples(left: readonly number[], right: readonly number[]): number {
  for (let index: number = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Missing segments are zero, so `<25` and `<25.0.0` mean the same thing. */
function versionTuple(value: unknown): number[] {
  const match: RegExpMatchArray | null = String(value || "")
    .replace(/^v/u, "")
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : [];
}
