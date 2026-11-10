import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Las pruebas E2E abren Chrome; en paralelo falsearían la medición de latencia.
    fileParallelism: false,
    // Un clic dentro de un iframe de otro sitio falla de vez en cuando (≈1 de cada 12 ejecuciones).
    // En CI se reintenta una vez para no bloquear un PR; en local se ve el fallo.
    retry: process.env.CI ? 1 : 0,
    // Muchas pruebas lanzan el CLI varias veces, cada vez como un proceso de Node nuevo. En el runner de
    // macOS eso pasa de los 5 s que vitest da por defecto, aunque en local tarden menos de 2 s.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
