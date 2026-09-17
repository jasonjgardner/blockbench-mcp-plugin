import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MAX_OFFSCREEN_VIEWS } from "@/lib/constants";
import {
  canCreateOffscreenView,
  createOffscreenView,
  deleteOffscreenView,
  describeView,
  getOffscreenViewCount,
  listViews,
  loadViewAngle,
  renderViewToDataUrl,
  resizeOffscreenView,
  resolveView,
  teardownOffscreenViews,
} from "@/lib/views";
import { useGlobals } from "@/tests/helpers/globals";
import { createPreviewHost, type IHostPreview, type IPreviewHost } from "@/tests/helpers/preview-host";

let host: IPreviewHost;
const size = { width: 640, height: 480, antialias: true };

beforeEach(() => {
  host = createPreviewHost();
});
// Registered before useGlobals so the registry is emptied while the host globals are still installed.
afterEach(() => teardownOffscreenViews());
useGlobals(() => ({ Canvas: host.Canvas, Preview: host.Preview }));

function hostPreview(id: string): IHostPreview {
  const preview = host.Preview.all.find(candidate => candidate.id === id);
  if (!preview) throw new Error(`Missing host preview "${id}".`);
  return preview;
}

test("resolveView targets the active viewport by default and keeps Blockbench's 'main' preview addressable", () => {
  expect<unknown>(resolveView()).toBe(host.main);
  expect<unknown>(resolveView("active")).toBe(host.main);
  expect<unknown>(resolveView("main")).toBe(host.main);
  const split = new host.Preview({ id: "split_screen_1" });
  host.Preview.selected = split;
  expect<unknown>(resolveView("active")).toBe(split);
  expect<unknown>(resolveView("main")).toBe(host.main);
  host.Preview.selected = null;
  expect<unknown>(resolveView()).toBe(host.main);
  expect(() => resolveView("nope")).toThrow(/Unknown view "nope"/);
});

test("offscreen views are sized before copying the active camera, live off the DOM, and never become selected", () => {
  host.main.camPers.position.fromArray([12.3456, 4, -8]);
  const info = createOffscreenView(size);
  expect(info).toEqual({
    id: "view_1",
    kind: "offscreen",
    active: false,
    width: 640,
    height: 480,
    antialias: true,
    camera: { projection: "perspective", position: [12.346, 4, -8], target: [0, 8, 0], fov: 45, zoom: 0.5, locked_angle: null },
  });
  const preview = resolveView("view_1");
  expect<unknown>(preview).not.toBe(host.main);
  expect(preview.id).toBe("mcp_offscreen_view_1");
  expect(preview.canvas.isConnected).toBe(false);
  expect(host.Preview.selected).toBe(host.main);
  expect(host.events).toEqual([
    "create:main",
    "create:mcp_offscreen_view_1",
    "resize:mcp_offscreen_view_1:640x480",
    "copy:mcp_offscreen_view_1<-main",
  ]);
});

test("generated IDs skip names an agent already chose", () => {
  createOffscreenView({ ...size, id: "view_1" });
  expect(createOffscreenView(size).id).toBe("view_2");
});

test("copy sources are validated before construction; 'none' keeps the default angle; any view can seed", () => {
  expect(() => createOffscreenView({ ...size, copyFrom: "missing" })).toThrow(/Unknown view "missing"/);
  expect(host.events.filter(event => event.startsWith("create:"))).toEqual(["create:main"]);
  host.main.camPers.position.fromArray([1, 2, 3]);
  expect(createOffscreenView({ ...size, copyFrom: "none" }).camera.position).toEqual([-80, 40, 80]);
  expect(host.events.some(event => event.startsWith("copy:"))).toBe(false);
  const split = new host.Preview({ id: "split_screen_1" });
  split.camPers.position.fromArray([7, 7, 7]);
  expect(createOffscreenView({ ...size, copyFrom: "split_screen_1" }).camera.position).toEqual([7, 7, 7]);
  expect(createOffscreenView({ ...size, copyFrom: "active" }).camera.position).toEqual([1, 2, 3]);
});

test("reserved, duplicate, viewport-colliding, and over-cap IDs are rejected without leaking previews", () => {
  ["active", "none"].forEach(id => expect(() => createOffscreenView({ ...size, id })).toThrow(/reserved/));
  expect(() => createOffscreenView({ ...size, id: "main" })).toThrow(/Blockbench viewport/);
  createOffscreenView({ ...size, id: "a" });
  expect(() => createOffscreenView({ ...size, id: "a" })).toThrow(/already exists/);
  Array.from({ length: MAX_OFFSCREEN_VIEWS - 1 }, () => createOffscreenView(size));
  expect(canCreateOffscreenView()).toBe(false);
  expect(() => createOffscreenView(size)).toThrow(new RegExp(`At most ${MAX_OFFSCREEN_VIEWS}`));
  expect(getOffscreenViewCount()).toBe(MAX_OFFSCREEN_VIEWS);
  expect(host.Preview.all.filter(preview => preview.offscreen)).toHaveLength(MAX_OFFSCREEN_VIEWS);
});

test("construction and copy failures surface clearly and never leave a preview behind", () => {
  host.main.camPers.position.toArray = () => {
    throw new Error("boom");
  };
  expect(() => createOffscreenView({ ...size, id: "copyfail" })).toThrow("boom");
  expect(host.events).toContain("delete:mcp_offscreen_copyfail");
  expect(host.Preview.all.map(preview => preview.id)).toEqual(["main"]);
  expect(getOffscreenViewCount()).toBe(0);

  const failing = Object.assign(function FailingPreview() {
    throw new Error("WebGL unavailable");
  }, { all: host.Preview.all, selected: host.main });
  Object.assign(globalThis, { Preview: failing });
  expect(() => createOffscreenView(size)).toThrow(/could not create an offscreen preview.*WebGL unavailable/);
  expect(getOffscreenViewCount()).toBe(0);
});

test("listViews reports connected viewports first, then offscreen views, and omits Blockbench's media previews", () => {
  new host.Preview({ id: "media", offscreen: true });
  createOffscreenView({ ...size, id: "inspect" });
  expect(listViews().map(view => [view.id, view.kind, view.active])).toEqual([
    ["main", "viewport", true],
    ["inspect", "offscreen", false],
  ]);
});

test("describeView reports viewport canvas size, locked side views, and rounded camera values", () => {
  host.main.resize(800, 600);
  host.main.loadAnglePreset({ position: [0, 50, 0], target: [0, 0, 0], projection: "orthographic", locked_angle: "top" });
  host.main.camOrtho.zoom = 1.23456;
  const info = describeView(resolveView());
  expect(info).toMatchObject({
    id: "main",
    kind: "viewport",
    active: true,
    width: 800,
    height: 600,
    camera: { projection: "orthographic", position: [0, 50, 0], target: [0, 0, 0], zoom: 1.235, locked_angle: "top" },
  });
  expect("antialias" in info).toBe(false);
});

test("loadViewAngle applies zoom, FOV, and side-view locks and leaves other views alone", () => {
  createOffscreenView({ ...size, id: "inspect" });
  const preview = resolveView("inspect");
  loadViewAngle(preview, { position: [0, 50, 0], target: [0, 0, 0], projection: "orthographic", zoom: 2 });
  expect(describeView(preview).camera).toMatchObject({ projection: "orthographic", position: [0, 50, 0], zoom: 2, locked_angle: null });
  loadViewAngle(preview, { position: [0, 50, 0], projection: "orthographic", locked_angle: "top" });
  expect(describeView(preview).camera).toMatchObject({ zoom: 2, locked_angle: "top" });
  loadViewAngle(preview, { position: [10, 10, 10], target: [0, 0, 0], projection: "perspective", fov: 30 });
  expect(describeView(preview).camera).toMatchObject({ projection: "perspective", fov: 30, locked_angle: null });
  expect(host.main.presets).toEqual([]);
});

test("rendering restores an offscreen camera that Blockbench re-targeted on a project switch", () => {
  createOffscreenView({ ...size, id: "inspect" });
  const preview = resolveView("inspect");
  loadViewAngle(preview, { position: [0, 50, 0], target: [0, 0, 0], projection: "orthographic", zoom: 2 });
  loadViewAngle(preview, { position: [0, 50, 0], projection: "orthographic", locked_angle: "top" });
  // ModelProject#loadEditorState() calls loadAnglePreset(default_angle) on every preview.
  preview.loadAnglePreset({ position: [-80, 40, 80], target: [0, 8, 0], projection: "perspective" });
  expect(describeView(preview).camera.projection).toBe("perspective");
  const start = host.events.length;
  renderViewToDataUrl(preview);
  expect(host.events.slice(start)).toEqual([
    "angle:mcp_offscreen_inspect",
    "gizmos:hidden",
    "render:mcp_offscreen_inspect",
    "gizmos:restored",
  ]);
  expect(describeView(preview).camera).toMatchObject({
    projection: "orthographic",
    position: [0, 50, 0],
    target: [0, 0, 0],
    zoom: 2,
    locked_angle: "top",
  });
  const settled = host.events.length;
  renderViewToDataUrl(preview);
  expect(host.events.slice(settled)).toEqual(["gizmos:hidden", "render:mcp_offscreen_inspect", "gizmos:restored"]);
});

test("a stale offscreen size is re-applied before rendering", () => {
  createOffscreenView({ ...size, id: "s" });
  const preview = hostPreview("mcp_offscreen_s");
  preview.width = 1;
  preview.height = 1;
  const start = host.events.length;
  renderViewToDataUrl(resolveView("s"));
  expect(host.events.slice(start)).toEqual([
    "resize:mcp_offscreen_s:640x480",
    "gizmos:hidden",
    "render:mcp_offscreen_s",
    "gizmos:restored",
  ]);
});

test("resize and delete update the registry; a failed disposal still drops the entry", () => {
  createOffscreenView({ ...size, id: "r" });
  expect(resizeOffscreenView("r", 320, 200)).toMatchObject({ width: 320, height: 200 });
  expect(host.events).toContain("resize:mcp_offscreen_r:320x200");
  const preview = resolveView("r");
  deleteOffscreenView("r");
  expect(host.events).toContain("delete:mcp_offscreen_r");
  expect(host.Preview.all).not.toContain(preview);
  expect(() => resolveView("r")).toThrow(/Unknown view/);
  expect(() => deleteOffscreenView("r")).toThrow(/Unknown offscreen view/);
  expect(() => resizeOffscreenView("r", 1, 1)).toThrow(/Unknown offscreen view/);

  createOffscreenView({ ...size, id: "broken" });
  hostPreview("mcp_offscreen_broken").delete = () => {
    throw new Error("dispose failed");
  };
  expect(() => deleteOffscreenView("broken")).toThrow("dispose failed");
  expect(getOffscreenViewCount()).toBe(0);
});

test("teardown disposes every offscreen view, continues past failures, and restarts generated IDs", () => {
  createOffscreenView(size);
  createOffscreenView({ ...size, id: "broken" });
  createOffscreenView(size);
  hostPreview("mcp_offscreen_broken").delete = () => {
    throw new Error("dispose failed");
  };
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    teardownOffscreenViews();
    expect(errors).toHaveBeenCalledTimes(1);
  } finally {
    errors.mockRestore();
  }
  expect(getOffscreenViewCount()).toBe(0);
  expect(host.events.filter(event => event.startsWith("delete:"))).toEqual(["delete:mcp_offscreen_view_1", "delete:mcp_offscreen_view_2"]);
  expect(createOffscreenView(size).id).toBe("view_1");
});

test("rendering an offscreen view hides gizmos and returns that view's frame without touching the viewport", () => {
  createOffscreenView({ ...size, id: "shot" });
  const start = host.events.length;
  expect(renderViewToDataUrl(resolveView("shot"))).toBe(`data:image/png;base64,${btoa("mcp_offscreen_shot:1")}`);
  expect(host.events.slice(start)).toEqual(["gizmos:hidden", "render:mcp_offscreen_shot", "gizmos:restored"]);
  expect(host.main.renders).toBe(0);
});

test("capturing a connected viewport repaints it with gizmos afterwards", () => {
  const start = host.events.length;
  expect(renderViewToDataUrl(resolveView())).toBe(`data:image/png;base64,${btoa("main:1")}`);
  expect(host.events.slice(start)).toEqual(["gizmos:hidden", "render:main", "gizmos:restored", "render:main"]);
});

test("a render failure inside the gizmo-free callback surfaces as an error after gizmos are restored", () => {
  host.main.render = () => {
    throw new Error("context lost");
  };
  expect(() => renderViewToDataUrl(resolveView())).toThrow(/Failed to render/);
  expect(host.events.slice(-3)).toEqual(["gizmos:hidden", "gizmos:error", "gizmos:restored"]);
});
