import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Las pruebas E2E abren Chrome; en paralelo falsearían la medición de latencia.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
});
