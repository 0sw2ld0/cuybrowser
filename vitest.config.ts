import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Las pruebas E2E abren Chrome; en paralelo falsearían la medición de latencia.
    fileParallelism: false,
    // Un clic dentro de un iframe de otro sitio falla de vez en cuando (≈1 de cada 12 ejecuciones).
    // En CI se reintenta una vez para no bloquear un PR; en local se ve el fallo.
    retry: process.env.CI ? 1 : 0,
    include: ["test/**/*.test.ts"],
  },
});
