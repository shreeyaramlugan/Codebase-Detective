import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },

  test: {
    globals: true,
    environment: "node",

    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "features/analysis/**/*.ts",
        "features/ai/**/*.ts",
        "features/research/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
  },
});
