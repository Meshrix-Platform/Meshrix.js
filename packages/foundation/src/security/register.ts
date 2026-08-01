// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerSecurityPlatformServices(registry?: any, {
  securityPermissions = null,
  consoleAuth = null,
  operationAuditStore = null,
  processIdentity = null,
  registerPlatformService = null
}: Record<string, any> = {}) : any {
  const register: any = typeof registerPlatformService === "function"
    ? registerPlatformService
    : (targetRegistry?: any, entry?: any) : any => {
        if (!targetRegistry || typeof targetRegistry.register !== "function") {
          throw new Error("A PlatformRegistry instance is required.");
        }
        return targetRegistry.register(entry);
      };
  return [
    register(registry, {
      id: "security.permissions.provider",
      platform: "security",
      label: "Security permissions provider",
      kind: "authorization-provider",
      ownerFeatureId: "security-permissions",
      value: securityPermissions
    }),
    register(registry, {
      id: "security.auth.console",
      platform: "security",
      label: "Console authentication",
      kind: "auth",
      ownerFeatureId: "security-permissions",
      value: consoleAuth
    }),
    register(registry, {
      id: "security.audit.operations",
      platform: "security",
      label: "Operation audit store",
      kind: "audit",
      ownerFeatureId: "security-permissions",
      value: operationAuditStore
    }),
    register(registry, {
      id: "security.process_identity",
      platform: "security",
      label: "Process identity service",
      kind: "identity-binding",
      ownerFeatureId: "security-permissions",
      value: processIdentity
    })
  ];
}
