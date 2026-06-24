import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
