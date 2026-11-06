import { describe, expect, it } from "vitest";
import { EventBuffer, latest, MAX_EVENTS_PER_TYPE } from "../../src/core/events.js";
import { isOlderVersion } from "../../src/ipc/client.js";

describe("buffer de eventos", () => {
  it("el tráfico de red no expulsa la consola", () => {
    const events = new EventBuffer();
    events.push("console", "t1", { level: "error", text: "fallo" });
    for (let i = 0; i < MAX_EVENTS_PER_TYPE + 50; i++) events.push("network", "t1", { url: `/r/${i}` });
    expect(events.list("console")).toHaveLength(1);
    expect(events.list("network")).toHaveLength(MAX_EVENTS_PER_TYPE);
    expect(events.list("network")[0]!.data.url).toBe("/r/50");
  });

  it("since filtra por seq global entre tipos", () => {
    const events = new EventBuffer();
    events.push("console", "t1", { text: "a" });
    events.push("network", "t1", { url: "/x" });
    events.push("console", "t1", { text: "b" });
    expect(events.list("console", 2).map((event) => event.data.text)).toEqual(["b"]);
  });

  it("latest devuelve los más recientes y avisa al recortar", () => {
    const warnings: string[] = [];
    expect(latest([1, 2, 3, 4], 2, warnings)).toEqual([3, 4]);
    expect(warnings[0]).toContain("2 eventos más recientes de 4");
    const none: string[] = [];
    expect(latest([1, 2], 5, none)).toEqual([1, 2]);
    expect(none).toEqual([]);
  });
});

describe("versión del daemon", () => {
  it("un daemon sin versión o anterior es más antiguo; uno igual o más nuevo, no", () => {
    expect(isOlderVersion(undefined, "0.1.0")).toBe(true);
    expect(isOlderVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isOlderVersion("0.9.9", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isOlderVersion("0.2.0", "0.1.9")).toBe(false);
    expect(isOlderVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
  });
});
