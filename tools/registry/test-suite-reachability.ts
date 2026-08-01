function asProfileMap(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveProfileSuites(profileName?: any, profiles?: any, cache?: any, visiting?: any, issues?: any) : any {
  if (cache.has(profileName)) {
    return cache.get(profileName);
  }
  if (visiting.has(profileName)) {
    issues.push(`tests: profile inheritance contains a cycle at "${profileName}"`);
    return new Set<any>();
  }
  const profile: any = profiles[profileName];
  if (!profile) {
    issues.push(`tests: profile inheritance references missing profile "${profileName}"`);
    return new Set<any>();
  }

  visiting.add(profileName);
  const resolved: any = new Set<any>();
  const baseName: any = String(profile.extends || "").trim();
  if (baseName) {
    for (const suiteId of resolveProfileSuites(baseName, profiles, cache, visiting, issues)) {
      resolved.add(suiteId);
    }
  }
  for (const suiteId of Array.isArray(profile.suites) ? profile.suites : []) {
    resolved.add(String(suiteId));
  }
  visiting.delete(profileName);
  cache.set(profileName, resolved);
  return resolved;
}

export function testSuiteReachabilityIssues(registry: Record<string, any> = {}) : any {
  const issues: any[] = [];
  const profiles: any = asProfileMap(registry.profiles);
  const publicProfileNames: any = (Object.entries(profiles) as [string, any][])
    .filter(([name, profile]: any[]) : any => name.endsWith("-public") && profile?.dynamic !== true)
    .map(([name]: any[]) : any => name)
    .sort();
  const cache: any = new Map<any, any>();
  const reachableSuiteIds: any = new Set<any>();

  for (const profileName of publicProfileNames) {
    for (const suiteId of resolveProfileSuites(profileName, profiles, cache, new Set<any>(), issues)) {
      reachableSuiteIds.add(suiteId);
    }
  }

  const coverageSuiteIds: any = (Array.isArray(registry.suites) ? registry.suites : [])
    .filter((suite?: any) : any => suite?.coverageContribution === true)
    .map((suite?: any) : any => String(suite?.id || "").trim())
    .filter(Boolean)
    .sort();
  if (coverageSuiteIds.length > 0 && publicProfileNames.length === 0) {
    issues.push("tests: coverage-contributing suites require at least one non-dynamic *-public profile");
    return issues;
  }
  for (const suiteId of coverageSuiteIds) {
    if (!reachableSuiteIds.has(suiteId)) {
      issues.push(`tests: coverage-contributing suite "${suiteId}" is unreachable from every public profile`);
    }
  }
  return [...new Set<any>(issues)];
}
