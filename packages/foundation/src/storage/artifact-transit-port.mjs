export const ARTIFACT_TRANSIT_REFERENCE_PREFIXES = Object.freeze([
  "upload",
  "artifact"
]);

const REFERENCE = /^(upload|artifact):([A-Za-z0-9_-]{8,160})(?::([0-9]{1,3}))?$/u;

export function parseArtifactTransitReference(value = "") {
  const match = REFERENCE.exec(String(value || "").trim());
  if (!match) {
    const error = new Error("Artifact reference is invalid.");
    error.code = "artifact_reference_invalid";
    error.status = 400;
    throw error;
  }
  const kind = match[1];
  const fileIndex = match[3] === undefined ? null : Number(match[3]);
  if ((kind === "upload" && fileIndex === null) || (kind === "artifact" && fileIndex !== null)) {
    const error = new Error("Artifact reference shape is invalid.");
    error.code = "artifact_reference_invalid";
    error.status = 400;
    throw error;
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
