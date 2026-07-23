function asProfileMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveProfileSuites(profileName, profiles, cache, visiting, issues) {
  if (cache.has(profileName)) {
    return cache.get(profileName);
  }
  if (visiting.has(profileName)) {
    issues.push(`tests: profile inheritance contains a cycle at "${profileName}"`);
    return new Set();
  }
  const profile = profiles[profileName];
  if (!profile) {
    issues.push(`tests: profile inheritance references missing profile "${profileName}"`);
    return new Set();
  }

  visiting.add(profileName);
  const resolved = new Set();
  const baseName = String(profile.extends || "").trim();
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

export function testSuiteReachabilityIssues(registry = {}) {
  const issues = [];
  const profiles = asProfileMap(registry.profiles);
  const publicProfileNames = Object.entries(profiles)
    .filter(([name, profile]) => name.endsWith("-public") && profile?.dynamic !== true)
    .map(([name]) => name)
    .sort();
  const cache = new Map();
  const reachableSuiteIds = new Set();

  for (const profileName of publicProfileNames) {
    for (const suiteId of resolveProfileSuites(profileName, profiles, cache, new Set(), issues)) {
      reachableSuiteIds.add(suiteId);
    }
  }

  const coverageSuiteIds = (Array.isArray(registry.suites) ? registry.suites : [])
    .filter((suite) => suite?.coverageContribution === true)
    .map((suite) => String(suite?.id || "").trim())
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
  return [...new Set(issues)];
}
