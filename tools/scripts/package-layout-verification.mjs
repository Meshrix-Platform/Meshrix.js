function normalizedPath(value = "") {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

export function packageIncludedMismatches(entries = [], packedFiles = []) {
  const normalizedPackedFiles = new Set([...packedFiles].map(normalizedPath).filter(Boolean));
  const includedPaths = new Set();
  for (const packedPath of normalizedPackedFiles) {
    const parts = packedPath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      includedPaths.add(parts.slice(0, index).join("/"));
    }
  }
  const mismatches = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = normalizedPath(entry?.name);
    if (!name || typeof entry?.packageIncluded !== "boolean") continue;
    const actualPackageIncluded = includedPaths.has(name);
    if (entry.packageIncluded !== actualPackageIncluded) {
      mismatches.push({
        name,
        declaredPackageIncluded: entry.packageIncluded,
        actualPackageIncluded
      });
    }
  }
  return mismatches;
}
