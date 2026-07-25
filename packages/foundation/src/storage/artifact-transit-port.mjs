export const ARTIFACT_TRANSIT_REFERENCE_PREFIXES = Object.freeze([
  "upload",
  "artifact",
  "workspace"
]);

const REFERENCE = /^(upload|artifact):([A-Za-z0-9_-]{8,160})(?::([0-9]{1,3}))?$/u;
const WORKSPACE_REFERENCE = /^workspace:([A-Za-z0-9_-]{8,160}):([^\x00-\x1f\x7f]{1,1024})$/u;

function invalidReferenceError(message = "Artifact reference is invalid.") {
  const error = new Error(message);
  error.code = "artifact_reference_invalid";
  error.status = 400;
  return error;
}

export function parseArtifactTransitReference(value = "") {
  const text = String(value || "").trim();
  const workspaceMatch = WORKSPACE_REFERENCE.exec(text);
  if (workspaceMatch) {
    return Object.freeze({
      kind: "workspace",
      id: workspaceMatch[1],
      path: workspaceMatch[2],
      fileIndex: null
    });
  }
  const match = REFERENCE.exec(text);
  if (!match) {
    throw invalidReferenceError();
  }
  const kind = match[1];
  const fileIndex = match[3] === undefined ? null : Number(match[3]);
  if ((kind === "upload" && fileIndex === null) || (kind === "artifact" && fileIndex !== null)) {
    throw invalidReferenceError("Artifact reference shape is invalid.");
  }
  return Object.freeze({ kind, id: match[2], fileIndex });
}

export function assertArtifactTransitPort(port) {
  const required = ["resolve", "openRead", "beginWrite", "commit", "abort", "close"];
  const missing = required.filter((method) => typeof port?.[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`ArtifactTransitPort is missing methods: ${missing.join(", ")}.`);
  }
  return port;
}
