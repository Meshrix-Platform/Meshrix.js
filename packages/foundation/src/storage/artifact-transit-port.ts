export const ARTIFACT_TRANSIT_REFERENCE_PREFIXES: readonly string[] = Object.freeze([
  "upload",
  "artifact",
  "workspace"
]);

const REFERENCE = /^(upload|artifact):([A-Za-z0-9_-]{8,160})(?::([0-9]{1,3}))?$/u;
const WORKSPACE_REFERENCE = /^workspace:([A-Za-z0-9_-]{8,160}):(.*)$/u;

export type ArtifactTransitReference =
  | Readonly<{ kind: "workspace"; id: string; path: string; fileIndex: null }>
  | Readonly<{ kind: "upload"; id: string; fileIndex: number }>
  | Readonly<{ kind: "artifact"; id: string; fileIndex: null }>;

export interface ArtifactTransitPort {
  resolve(...args: unknown[]): unknown;
  openRead(...args: unknown[]): unknown;
  beginWrite(...args: unknown[]): unknown;
  commit(...args: unknown[]): unknown;
  abort(...args: unknown[]): unknown;
  close(...args: unknown[]): unknown;
}

function invalidReferenceError(message = "Artifact reference is invalid."): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = "artifact_reference_invalid";
  error.status = 400;
  return error;
}

export function parseArtifactTransitReference(value: unknown = ""): ArtifactTransitReference {
  const text = String(value || "").trim();
  const workspaceMatch = WORKSPACE_REFERENCE.exec(text);
  if (workspaceMatch) {
    const workspacePath = workspaceMatch[2];
    if (
      workspacePath.length === 0 ||
      workspacePath.length > 1024 ||
      [...workspacePath].some((character) => {
        const code = character.codePointAt(0) || 0;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw invalidReferenceError();
    }
    return Object.freeze({
      kind: "workspace",
      id: workspaceMatch[1],
      path: workspacePath,
      fileIndex: null
    });
  }
  const match = REFERENCE.exec(text);
  if (!match) {
    throw invalidReferenceError();
  }
  const kind = match[1] as "upload" | "artifact";
  const fileIndex = match[3] === undefined ? null : Number(match[3]);
  if ((kind === "upload" && fileIndex === null) || (kind === "artifact" && fileIndex !== null)) {
    throw invalidReferenceError("Artifact reference shape is invalid.");
  }
  return Object.freeze({ kind, id: match[2], fileIndex }) as ArtifactTransitReference;
}

export function assertArtifactTransitPort<T>(port: T): T & ArtifactTransitPort {
  const required = ["resolve", "openRead", "beginWrite", "commit", "abort", "close"] as const;
  const candidate = port as T & Partial<ArtifactTransitPort>;
  const missing = required.filter((method) => typeof candidate?.[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`ArtifactTransitPort is missing methods: ${missing.join(", ")}.`);
  }
  return port as T & ArtifactTransitPort;
}
