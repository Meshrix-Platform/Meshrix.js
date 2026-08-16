// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
interface SecurityPlatformServiceEntry {
  id: string;
  platform: "security";
  label: string;
  kind: string;
  ownerFeatureId: "security-permissions";
  value: unknown;
}

interface SecurityPlatformRegistry {
  register(entry: SecurityPlatformServiceEntry): unknown;
}

type RegisterPlatformService = (registry: SecurityPlatformRegistry | undefined, entry: SecurityPlatformServiceEntry) => unknown;

interface SecurityPlatformServices {
  securityPermissions?: unknown;
  consoleAuth?: unknown;
  operationAuditStore?: unknown;
  processIdentity?: unknown;
  registerPlatformService?: RegisterPlatformService | null;
}

export function registerSecurityPlatformServices(registry?: SecurityPlatformRegistry, {
  securityPermissions = null,
  consoleAuth = null,
  operationAuditStore = null,
  processIdentity = null,
  registerPlatformService = null
}: SecurityPlatformServices = {}): unknown[] {
  const register: RegisterPlatformService = typeof registerPlatformService === "function"
    ? registerPlatformService
    : (targetRegistry, entry) => {
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
