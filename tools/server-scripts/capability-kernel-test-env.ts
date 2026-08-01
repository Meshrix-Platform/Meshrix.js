export function useIsolatedCapabilityKernelForVerifier() : any {
  const originalEnv: Record<string, any> = {
    MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER,
    MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER,
    MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER,
    MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER: process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER
  };

  process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER = "local-file";
  process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER = "local-file";

  return () : any => {
    for (const [key, value] of (Object.entries(originalEnv) as [string, any][])) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
