import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Real local Workerd via vitest-pool-workers (Miniflare). Durable Object
// storage stays in local in-memory SQLite; nothing reaches Cloudflare.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  resolve: {
    // The contracts package publishes TypeScript sources under the "source"
    // export condition; no compiled dist artifacts participate in this check.
    conditions: ["source"],
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
