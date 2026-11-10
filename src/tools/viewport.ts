import { z } from "zod";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1100, height: 800 },
} as const;

export default defineTool({
  name: "viewport",
  description: "Cambia el tamaño de la página activa para probar su diseño adaptable. Usa mobile (390×844), tablet (768×1024), desktop (1100×800), o width y height en píxeles. Las pestañas nuevas conservan el tamaño elegido. No cambia el agente de usuario ni oculta la automatización.",
  params: z.strictObject({
    preset: z.enum(["mobile", "tablet", "desktop"]).optional().describe("Tamaño predefinido, en lugar de width y height."),
    width: z.number().int().min(1).max(8192).optional().describe("Ancho de la página en píxeles; requiere height."),
    height: z.number().int().min(1).max(8192).optional().describe("Alto de la página en píxeles; requiere width."),
  }),
  risk: "action",
  cli: { positional: ["preset"] },
  handler: async ({ session }, { preset, width, height }) => {
    if (preset !== undefined && (width !== undefined || height !== undefined)) {
      throw new CuyError("INVALID_PARAMS", "Elige preset o width y height, sin mezclarlos.");
    }
    if (preset === undefined && (width === undefined || height === undefined)) {
      throw new CuyError("INVALID_PARAMS", "Indica preset o ambos tamaños: width y height.");
    }
    const size = preset === undefined ? { width: width!, height: height! } : VIEWPORTS[preset];
    await session.setViewport(size);
    return { tab: session.activeTab().id, ...size };
  },
});
