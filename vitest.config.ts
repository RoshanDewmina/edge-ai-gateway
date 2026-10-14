import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                PRIMARY_URL: "mock://primary?latencyMs=5",
                SECONDARY_URL: "mock://secondary?latencyMs=5",
                RATE_LIMIT_CAPACITY: "3",
                RATE_LIMIT_REFILL_PER_SEC: "0.01",
              },
            },
          }),
        ],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      }),
    ],
  },
});
