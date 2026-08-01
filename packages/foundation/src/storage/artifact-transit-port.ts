export const ARTIFACT_TRANSIT_REFERENCE_PREFIXES: readonly any[] = Object.freeze([
  "upload",
  "artifact",
  "workspace"
]);

const REFERENCE: any = /^(upload|artifact):([A-Za-z0-9_-]{8,160})(?::([0-9]{1,3}))?$/u;
const WORKSPACE_REFERENCE: any = /^workspace:([A-Za-z0-9_-]{8,160}):([^\x00-\x1f\x7f]{1,1024})$/u;

function invalidReferenceError(message: any = "Artifact reference is invalid.") : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = "artifact_reference_invalid";
  error.status = 400;
  return error;
}

export function parseArtifactTransitReference(value: any = "") : any {
  const text: any = String(value || "").trim();
  const workspaceMatch: any = WORKSPACE_REFERENCE.exec(text);
  if (workspaceMatch) {
    return Object.freeze({
      kind: "workspace",
      id: workspaceMatch[1],
      path: workspaceMatch[2],
      fileIndex: null
    });
  }
  const match: any = REFERENCE.exec(text);
  if (!match) {
    throw invalidReferenceError();
  }
  const kind: any = match[1];
  const fileIndex: any = match[3] === undefined ? null : Number(match[3]);
  if ((kind === "upload" && fileIndex === null) || (kind === "artifact" && fileIndex !== null)) {
    throw invalidReferenceError("Artifact reference shape is invalid.");
  }
  return Object.freeze({ kind, id: match[2], fileIndex });
}

export function assertArtifactTransitPort(port?: any) : any {
  const required: any[] = ["resolve", "openRead", "beginWrite", "commit", "abort", "close"];
  const missing: any = required.filter((method?: any) : any => typeof port?.[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`ArtifactTransitPort is missing methods: ${missing.join(", ")}.`);
  }
  return port;
}
