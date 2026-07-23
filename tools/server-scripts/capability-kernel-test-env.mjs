export function useIsolatedCapabilityKernelForVerifier() {
  const originalEnv = {
    LICO_TOOL_GRANT_CAPABILITY_KEY_PROVIDER: process.env.LICO_TOOL_GRANT_CAPABILITY_KEY_PROVIDER,
    LICO_TOOL_GRANT_BINDING_GUARD_PROVIDER: process.env.LICO_TOOL_GRANT_BINDING_GUARD_PROVIDER,
    LICO_OPAQUE_CAPABILITY_KEY_PROVIDER: process.env.LICO_OPAQUE_CAPABILITY_KEY_PROVIDER,
    LICO_CAPABILITY_BINDING_GUARD_PROVIDER: process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER
  };

  process.env.LICO_TOOL_GRANT_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.LICO_TOOL_GRANT_BINDING_GUARD_PROVIDER = "local-file";
  process.env.LICO_OPAQUE_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER = "local-file";

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
