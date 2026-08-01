function normalizedPath(value: any = "") : any {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

export function packageIncludedMismatches(entries: any = [], packedFiles: any = []) : any {
  const normalizedPackedFiles: any = new Set<any>([...packedFiles].map(normalizedPath).filter(Boolean));
  const includedPaths: any = new Set<any>();
  for (const packedPath of normalizedPackedFiles) {
    const parts: any = packedPath.split("/");
    for (let index: any = 1; index <= parts.length; index += 1) {
      includedPaths.add(parts.slice(0, index).join("/"));
    }
  }
  const mismatches: any[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name: any = normalizedPath(entry?.name);
    if (!name || typeof entry?.packageIncluded !== "boolean") continue;
    const actualPackageIncluded: any = includedPaths.has(name);
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
