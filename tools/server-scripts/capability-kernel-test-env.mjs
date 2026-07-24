export function useIsolatedCapabilityKernelForVerifier() {
  const originalEnv = {
    MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER,
    MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER,
    MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER,
    MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER: process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER
  };

  process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER = "local-file";
  process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER = "local-file";

  return () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
