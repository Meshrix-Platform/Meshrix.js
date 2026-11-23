import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "mock-cloudflare-workers-runtime",
      resolveId(id) {
        if (id === "cloudflare:workers") {
          return "\0virtual:cloudflare-workers";
        }
        return undefined;
      },
      load(id) {
        if (id === "\0virtual:cloudflare-workers") {
          return `
            export class DurableObject {
              constructor(ctx, env) {
                this.ctx = ctx;
                this.env = env;
              }
            }
          `;
        }
        return undefined;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
