import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Core } from "../../src/core/core.js";
import { tools } from "../../src/tools/index.js";

const home = mkdtempSync(join(tmpdir(), "cb-viewport-"));
process.env.CUYBROWSER_HOME = home;
let core: Core;

beforeAll(async () => {
  core = new Core(tools, { request: async () => "denied" });
  const result = await core.call("start", { headless: true });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await core.session.activeTab().page.setContent('<style>@media(max-width:600px){body{background:rgb(1, 2, 3)}}</style><h1>Demo adaptable</h1><button>Probar</button>');
}, 60_000);

afterAll(async () => {
  await core?.shutdown();
  rmSync(home, { recursive: true, force: true });
});

describe("viewport", () => {
  it("aplica presets y las media queries responden al ancho real de la página", async () => {
    const ua = await core.session.activeTab().page.evaluate(() => navigator.userAgent);
    for (const [preset, width, height] of [["mobile", 390, 844], ["tablet", 768, 1024], ["desktop", 1100, 800]] as const) {
      const result: any = await core.call("viewport", { preset });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const actual = await core.session.activeTab().page.evaluate(() => ({
        width: innerWidth, height: innerHeight, mobile: matchMedia("(max-width:600px)").matches,
        ua: navigator.userAgent,
      }));
      expect(actual).toEqual({ width, height, mobile: preset === "mobile", ua });
    }
  });

  it("acepta tamaño propio, conserva las refs y lo heredan las pestañas nuevas", async () => {
    const tab = core.session.activeTab();
    const snapshot: any = await core.call("snapshot", {});
    const ref = snapshot.data.text.match(/\[(e\d+)\]/)[1];
    const target = tab.refs.resolve(ref);
    expect((await core.call("viewport", { width: 901, height: 607 })).ok).toBe(true);
    expect(tab.refs.resolve(ref)).toEqual(target);
    const next = await core.session.newTab();
    expect(next.page.viewportSize()).toEqual({ width: 901, height: 607 });
    await core.session.closeTab(next.id);
  });

  it.each([{}, { width: 390 }, { height: 844 }, { preset: "mobile", width: 390 },
    { preset: "otro" }, { width: 0, height: 800 }, { width: 100, height: 8193 }, { width: 1.5, height: 800 }])(
    "rechaza parámetros inválidos: %j", async (params) => {
      const result: any = await core.call("viewport", params);
      expect(result.error.code).toBe("INVALID_PARAMS");
    },
  );
});
