import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebAppFileLinks, buildWebAppLinks, escapeJsonForQuery, type IWebAppOptions, launcherHtml, linkOrNote, normalizeWebAppUrl, prepareModelForWeb, webAppField, webAppUrl } from "./web-link";

/** Blockbench's own query parser (js/web.ts), applied to the fragment the browser would expose. */
function blockbenchQueries(url: string): Record<string, string | true> {
  const query = decodeURIComponent(new URL(url).hash.substring(1));
  return Object.fromEntries(
    query.split("&").map((part) => {
      const [key = "", value] = part.split(/=\s*(.+)/);
      return [key, value || true];
    }),
  );
}

const loaded = (url: string): unknown => JSON.parse(String(blockbenchQueries(url).loaddata));

const tricky = "a & b = c % d # e + f\né\u2028g\u2029h 🦦 <x> \"q\" (p)";
const model = (source = "data:image/png;base64,AAAA"): Record<string, unknown> => ({
  meta: { format_version: "5.0", model_format: "free", box_uv: false },
  name: tricky,
  elements: [{ uuid: "c1", name: tricky, type: "cube", from: [0, 0, 0], to: [16, 16, 16] }],
  textures: [{ uuid: "t1", name: "skin.png", path: "C:\\Users\\me\\skin.png", relative_path: "../skin.png", source }],
});

let dir = "";
const options = (overrides: Partial<IWebAppOptions> = {}): IWebAppOptions => ({
  enabled: true,
  baseUrl: "https://web.blockbench.net/",
  inlineMax: 8000,
  browserMax: 2_000_000,
  launcherDir: dir,
  ...overrides,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-weblink-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("webAppUrl", () => {
  test("survives Blockbench's single decode, & split and first-= split with hostile strings", () => {
    const doc = model();
    const url = webAppUrl(JSON.stringify(doc), "chair.bbmodel");
    const queries = blockbenchQueries(url);
    expect(queries.loadtype).toBe("json");
    expect(queries.loadname).toBe("chair.bbmodel");
    expect(JSON.parse(String(queries.loaddata))).toEqual(doc);
  });

  test("puts the payload in the fragment so it never reaches the server", () => {
    const url = new URL(webAppUrl("{}", "a.bbmodel"));
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#loadtype=json&loadname=a.bbmodel&loaddata=")).toBe(true);
  });

  test("re-serializes pretty JSON compactly (Blockbench's regex stops at line breaks)", () => {
    const url = webAppUrl(JSON.stringify({ a: [1, 2], b: "x" }, null, "\t"), "a.bbmodel");
    expect(loaded(url)).toEqual({ a: [1, 2], b: "x" });
    expect(decodeURIComponent(new URL(url).hash)).not.toMatch(/[\n\r]/);
  });

  test("keeps file names from breaking the query", () => {
    expect(blockbenchQueries(webAppUrl("{}", "a&b=c#d.bbmodel")).loadname).toBe("a_b_c_d.bbmodel");
  });

  test("refuses non-JSON text that would split the query", () => {
    expect(() => webAppUrl("a & b", "x.txt")).toThrow(/cannot travel/);
  });

  test("escapes & and JS line separators only inside the JSON text", () => {
    expect(escapeJsonForQuery('{"a":"x&y\u2028"}')).toBe('{"a":"x\\u0026y\\u2028"}');
  });
});

describe("prepareModelForWeb", () => {
  test("drops local texture paths and keeps images unless stripped", () => {
    const kept = prepareModelForWeb(model(), false).textures as Record<string, unknown>[];
    expect(kept[0]).toEqual({ uuid: "t1", name: "skin.png", source: "data:image/png;base64,AAAA" });
    const stripped = prepareModelForWeb(model(), true).textures as Record<string, unknown>[];
    expect(stripped[0]).toEqual({ uuid: "t1", name: "skin.png" });
  });
});

describe("local paths never travel in a link", () => {
  test("animation files, animation controllers and sound keyframes lose their paths", () => {
    const doc = {
      textures: [],
      animations: [{ name: "walk", path: "C:/me/walk.animation.json", animators: { effects: { keyframes: [{ channel: "sound", data_points: [{ effect: "step", file: "C:/me/step.ogg" }] }] } } }],
      animation_controllers: [{ name: "move", path: "C:/me/move.controller.json", states: [] }],
    };
    const text = JSON.stringify(prepareModelForWeb(doc, false));
    expect(text).not.toContain("C:/me");
    expect(text).toContain('"effect":"step"');
  });

  test("malformed texture entries are skipped instead of throwing", () => {
    expect(prepareModelForWeb({ textures: [null, "x", { name: "ok" }] }, false).textures).toEqual([{ name: "ok" }]);
  });
});

describe("options and failures", () => {
  test("the web app URL must be http(s) with no query or fragment", () => {
    expect(normalizeWebAppUrl("https://web.blockbench.net")).toBe("https://web.blockbench.net/");
    expect(() => normalizeWebAppUrl("https://web.blockbench.net/?lang=de")).toThrow(/query string/);
    expect(() => normalizeWebAppUrl("javascript:alert(1)")).toThrow();
  });

  test("links switched off add nothing, and a failing link becomes a note", async () => {
    expect(await webAppField({ textures: [] }, "/m/a.bbmodel", options({ enabled: false }))).toEqual({});
    expect((await linkOrNote(Promise.reject(new Error("boom")))).note).toBe("No web-app link: boom");
  });
});

describe("buildWebAppLinks tiers", () => {
  test("a small model gets the full URL inline", async () => {
    const links = await buildWebAppLinks(model(), "chair", options());
    expect(links.url).toBeDefined();
    expect(links.geometry_url).toBeUndefined();
    expect(links.launcher).toBeUndefined();
    expect(blockbenchQueries(links.url as string).loadname).toBe("chair.bbmodel");
  });

  test("a heavy texture moves the full model into a launcher and inlines the geometry", async () => {
    const heavy = model(`data:image/png;base64,${"A".repeat(20_000)}`);
    const links = await buildWebAppLinks(heavy, "chair.bbmodel", options(), "/abs/chair.bbmodel");
    expect(links.url).toBeUndefined();
    expect((loaded(links.geometry_url as string) as { textures: unknown[] }).textures[0]).toEqual({ uuid: "t1", name: "skin.png" });
    const html = await Bun.file(links.launcher?.path as string).text();
    const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"') ?? "";
    expect(loaded(href)).toEqual(prepareModelForWeb(heavy, false));
    expect(links.launcher?.file_url.startsWith("file:")).toBe(true);
    expect(links.note).toMatch(/launcher/);
  });

  test("past the browser limit there is no launcher, only a pointer to the desktop app", async () => {
    const links = await buildWebAppLinks(model(`data:image/png;base64,${"A".repeat(20_000)}`), "chair", options({ browserMax: 10_000 }));
    expect(links.launcher).toBeUndefined();
    expect(links.note).toMatch(/blockbench_launch/);
  });

  test("launchers of same-named files in different folders do not collide", async () => {
    const heavy = model(`data:image/png;base64,${"A".repeat(20_000)}`);
    const a = await buildWebAppLinks(heavy, "chair.bbmodel", options(), "/one/chair.bbmodel");
    const b = await buildWebAppLinks(heavy, "chair.bbmodel", options(), "/two/chair.bbmodel");
    expect(a.launcher?.path).not.toBe(b.launcher?.path);
  });
});

describe("buildWebAppFileLinks", () => {
  test("carries other model files under their own name so the right codec loads them", async () => {
    const links = await buildWebAppFileLinks('{"format_version":"1.12.0"}', "chair.geo.json", options());
    expect(blockbenchQueries(links.url as string).loadname).toBe("chair.geo.json");
  });
});

describe("launcherHtml", () => {
  test("escapes the title and the attribute", () => {
    const html = launcherHtml('https://x/#a=1&b="2"', "<chair>&co");
    expect(html).toContain('href="https://x/#a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain("&lt;chair>&amp;co");
  });
});
