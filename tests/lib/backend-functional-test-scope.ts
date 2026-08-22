export const BACKEND_FUNCTIONAL_SCOPE_ENV = "MESHRIX_VITEST_SCOPE";
export const BACKEND_FUNCTIONAL_SCOPE = "backend-functional";

export const backendFunctionalExcludedTestPatterns: readonly string[] = Object.freeze([
  "tests/vitest/server/resource-discipline-policy.test.ts",
  "tests/vitest/server/job-pipeline-upload-session-persistence.test.ts",
  "tests/vitest/server/upload-custody-workspace-materialization.test.ts",
  "tests/vitest/server/external-gateway-plugin.test.ts",
  "tests/vitest/server/operation-audit-retention.test.ts"
]);

export function isBackendFunctionalScope(
  environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return environment[BACKEND_FUNCTIONAL_SCOPE_ENV] === BACKEND_FUNCTIONAL_SCOPE;
}

export function backendFunctionalScopeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [BACKEND_FUNCTIONAL_SCOPE_ENV]: BACKEND_FUNCTIONAL_SCOPE
  };
}
