/**
 * Tag Store Port — Foundation boundary for tag/authorization storage access.
 *
 * This is the CANONICAL port that decouples security (foundation) from
 * runtime state implementations.  Authorization modules depend only on
 * this port; the runtime tag-state adapter implements it.
 *
 * ## Contract
 *
 * - **Consumer**: `authorization-governance-store.ts`, `security-permissions-provider.ts`
 *   and other security modules use `registry.getProvider()` and call through the
 *   port interface.
 * - **Provider**: `packages/server-runtime/src/state/tag-store-adapter.ts` implements
 *   this port and registers itself at composition time.
 * - **Composition**: `packages/server-runtime/src/composition/register-domain-loaders.ts`
 *   wires the provider into the registry.
 * - **Fail-closed**: If no provider is registered, authorization operations that
 *   require tag-store access MUST fail with a structured diagnostic — never silently
 *   succeed or fall back to a default.
 * - **Foundation does NOT import runtime/tag-state**: No file under
 *   `packages/foundation/security/` may directly import from
 *   `packages/server-runtime/state/` or `packages/server-runtime/src/state/`.
 *
 * ## Audit / Diagnostic Evidence
 *
 * Every provider method SHOULD emit diagnostic evidence when it errors, including:
 *
 * - **Provider missing**: If `getProvider()` returns null, consumers must call
 *   `getProviderDiagnostic()` to obtain the structured diagnostic describing the
 *   unregistered state.  The noop provider (`createNoopTagStoreProvider`) throws
 *   with a clear message on every method call — this is the fail-closed behaviour.
 * - **Provider error**: The adapter implementation SHOULD wrap runtime errors
 *   with `provider: "tag-store-adapter"`, the originating method name, and a
 *   timestamp so that operational dashboards can surface the failing provider.
 * - **Registry diagnostic**: `getProviderDiagnostic()` returns the provider's
 *   `diagnostic` property (if set) or a fallback diagnostic indicating no provider.
 *   This enables operations to distinguish "not wired" from "wired but broken".
 *
 * ## Architecture enforcement
 *
 * Architecture verifier rule `foundation-security-not-import-runtime-tag-state`
 * forbids direct imports from runtime/tag-state in foundation/security files.
 *
 * @module tag-store-port
 * @package @meshrix/foundation
 * @layer foundation/security
 */

export const TAG_STORE_PORT_VERSION: any = "v0.0.1:authorization:tag-store-port-0.4.0";

/**
 * @typedef {object} TagStoreProviderDiagnostic
 * @property {string} status - "registered" | "not_registered" | "errored"
 * @property {string} [providerId] - Identifier of the registered provider
 * @property {string} [error] - Error message if the provider is in an errored state
 * @property {string} timestamp - ISO timestamp of the diagnostic snapshot
 * @property {string} interfaceVersion - The tag store port version in use
 */

/**
 * @typedef {object} TagStoreProvider
 *
 * @property {(userDataPath: string) => TagStoreProvider} createTagManagementStore
 * @property {() => string | null} getPolicyRevision
 * @property {(input: object) => Array<object>} listTags
 * @property {(tagId: string) => object | null} getTag
 * @property {(input: object) => object} upsertTag
 * @property {(tagId: string, input?: object) => object} archiveTag
 * @property {(tagId: string) => object} restoreTag
 * @property {(input: object) => Array<object>} listProjections
 * @property {() => object} rebuildProjections
 * @property {(input: object) => Array<object>} listEvents
 * @property {(input: object) => Array<object>} listToolProfiles
 * @property {(profiles: Array<object>) => {created: number}} seedToolProfiles
 * @property {(role: object, opts?: object) => object} upsertAuthorizationRole
 * @property {(roleId: string) => object | null} getAuthorizationRole
 * @property {(opts?: {includeDisabled?: boolean}) => Array<object>} listAuthorizationRoles
 * @property {(team: object) => object} upsertAuthorizationTeam
 * @property {(teamId: string) => object | null} getAuthorizationTeam
 * @property {(opts?: {includeDisabled?: boolean}) => Array<object>} listAuthorizationTeams
 * @property {(department: object) => object} upsertAuthorizationDepartment
 * @property {(departmentId: string) => object | null} getAuthorizationDepartment
 * @property {(opts?: {includeDisabled?: boolean}) => Array<object>} listAuthorizationDepartments
 * @property {(group: object) => object} upsertAuthorizationAgentGroup
 * @property {(groupId: string) => object | null} getAuthorizationAgentGroup
 * @property {(opts?: {includeDisabled?: boolean}) => Array<object>} listAuthorizationAgentGroups
 * @property {(binding: object) => object} upsertAuthorizationAgentBinding
 * @property {(agentId: string) => object | null} getAuthorizationAgentBinding
 * @property {() => Array<object>} listAuthorizationAgentBindings
 * @property {(projectionKind: string, id: string) => boolean} hasProjection
 * @property {() => void} close
 */

/**
 * @typedef {object} TagStoreProviderRegistry
 * @property {() => TagStoreProvider | null} getProvider
 * @property {(provider: TagStoreProvider) => void} setProvider
 * @property {() => boolean} hasProvider
 * @property {() => TagStoreProviderDiagnostic} getProviderDiagnostic
 */

/**
 * Creates a tag store provider registry for composition-time wiring.
 *
 * @returns {TagStoreProviderRegistry}
 */
export function createTagStoreProviderRegistry() : any {
  /** @type {TagStoreProvider | null} */
  let provider: any = null;
  let registeredAt: any = null;

  return {
    getProvider() : any {
      return provider;
    },
    setProvider(newProvider?: any) : any {
      provider = newProvider;
      registeredAt = new Date().toISOString();
    },
    hasProvider() : any {
      return provider !== null;
    },
    getProviderDiagnostic() : any {
      if (provider) {
        return {
          status: "registered",
          providerId: provider.constructor?.name || "TagStoreProvider",
          timestamp: registeredAt || new Date().toISOString(),
          interfaceVersion: TAG_STORE_PORT_VERSION
        };
      }
      return {
        status: "not_registered",
        timestamp: new Date().toISOString(),
        interfaceVersion: TAG_STORE_PORT_VERSION
      };
    }
  };
}

/**
 * Validates that a given store implementation conforms to the expected
 * interface shape.  Used during composition to assert the registered
 * implementation provides all required methods.
 *
 * @param {TagStoreProvider} store
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateTagStoreProvider(store?: any) : any {
  const required: any[] = [
    "getPolicyRevision",
    "listTags", "getTag", "upsertTag", "archiveTag", "restoreTag",
    "listProjections", "rebuildProjections",
    "listEvents",
    "listToolProfiles", "seedToolProfiles",
    "upsertAuthorizationRole", "getAuthorizationRole", "listAuthorizationRoles",
    "upsertAuthorizationTeam", "getAuthorizationTeam", "listAuthorizationTeams",
    "upsertAuthorizationDepartment", "getAuthorizationDepartment", "listAuthorizationDepartments",
    "upsertAuthorizationAgentGroup", "getAuthorizationAgentGroup", "listAuthorizationAgentGroups",
    "upsertAuthorizationAgentBinding", "getAuthorizationAgentBinding", "listAuthorizationAgentBindings",
    "hasProjection",
  ];
  const missing: any = required.filter((method?: any) : any => typeof store?.[method] !== "function");
  return { valid: missing.length === 0, missing };
}

/**
 * Returns a fail-closed tag store that throws on every access method.
 * Used when no real provider is registered.
 *
 * Each thrown error includes a `diagnostic` property with structured
 * diagnostic evidence (interface version, timestamp, method name) for
 * operational dashboards and audit trails.
 *
 * @returns {TagStoreProvider}
 */
export function createNoopTagStoreProvider() : any {
  const failClosed: any = (method?: any) : any => {
    const fn: any = () : any => {
      const diagnostic: Record<string, any> = {
        method,
        provider: "noop",
        status: "provider_not_registered",
        interfaceVersion: TAG_STORE_PORT_VERSION,
        timestamp: new Date().toISOString(),
        hint: "Ensure tag-store adapter is wired via registerTagStoreProvider() at composition time."
      };
      const error: Error & Record<string, any> = new Error(
        `TagStoreProvider.${method}() called but no provider is registered. ` +
        "Ensure tag-store adapter is wired via registerTagStoreProvider() at composition time."
      );
      error.diagnostic = diagnostic;
      throw error;
    };
    return fn;
  };

  return {
    getPolicyRevision: failClosed("getPolicyRevision"),
    listTags: failClosed("listTags"),
    getTag: failClosed("getTag"),
    upsertTag: failClosed("upsertTag"),
    archiveTag: failClosed("archiveTag"),
    restoreTag: failClosed("restoreTag"),
    listProjections: failClosed("listProjections"),
    rebuildProjections: failClosed("rebuildProjections"),
    listEvents: failClosed("listEvents"),
    listToolProfiles: failClosed("listToolProfiles"),
    seedToolProfiles: failClosed("seedToolProfiles"),
    upsertAuthorizationRole: failClosed("upsertAuthorizationRole"),
    getAuthorizationRole: failClosed("getAuthorizationRole"),
    listAuthorizationRoles: failClosed("listAuthorizationRoles"),
    upsertAuthorizationTeam: failClosed("upsertAuthorizationTeam"),
    getAuthorizationTeam: failClosed("getAuthorizationTeam"),
    listAuthorizationTeams: failClosed("listAuthorizationTeams"),
    upsertAuthorizationDepartment: failClosed("upsertAuthorizationDepartment"),
    getAuthorizationDepartment: failClosed("getAuthorizationDepartment"),
    listAuthorizationDepartments: failClosed("listAuthorizationDepartments"),
    upsertAuthorizationAgentGroup: failClosed("upsertAuthorizationAgentGroup"),
    getAuthorizationAgentGroup: failClosed("getAuthorizationAgentGroup"),
    listAuthorizationAgentGroups: failClosed("listAuthorizationAgentGroups"),
    upsertAuthorizationAgentBinding: failClosed("upsertAuthorizationAgentBinding"),
    getAuthorizationAgentBinding: failClosed("getAuthorizationAgentBinding"),
    listAuthorizationAgentBindings: failClosed("listAuthorizationAgentBindings"),
    hasProjection: failClosed("hasProjection"),
    close: () : any => {}
  };
}
