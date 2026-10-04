import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the default run scoped to the real test suite; scratch/experiment
    // files elsewhere in the repo must not be picked up by `npm test`.
    include: ["test/**/*.test.ts"],
  },
});
