import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_OFFSCREEN_VIEWS } from "@/lib/constants";
import { isRecord } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { createPreviewHost, type IHostPreview, type IPreviewHost } from "@/tests/helpers/preview-host";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

interface IHostProject {
  name: string;
  uuid: string;
  selected: boolean;
  select(): void;
}

interface ICapture {
  /** Decoded `<preview id>:<render count>` marker the host encodes into every frame. */
  frame: string;
  structured: unknown;
}

let tools: IToolFixture;
let host: IPreviewHost;
let project: IHostProject;

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/camera.ts"], register: ["registerCameraTools"] });
});

beforeEach(() => {
  host = createPreviewHost();
  project = {
    name: "Model",
    uuid: "project-1",
    selected: true,
    select() {
      this.selected = true;
    },
  };
});

// Registered before useGlobals so the bundle's view registry is emptied while the host globals are still installed.
afterEach(async () => {
  const listed = await callJson("list_views");
  const views = Array.isArray(listed.views) ? listed.views.filter(isRecord) : [];
  await Promise.all(
    views.filter(view => view.kind === "offscreen").map(view => tools.call("delete_offscreen_view", { view: view.id }))
  );
});

useGlobals(() => ({
  Canvas: host.Canvas,
  ModelProject: { all: [project] },
  Preview: host.Preview,
  Project: project,
}));

async function callJson(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = CallToolResultSchema.parse(await tools.call(name, input));
  const item = result.content.find(content => content.type === "text");
  if (!item || item.type !== "text") throw new Error(`Expected a JSON result from ${name}.`);
  const parsed: unknown = JSON.parse(item.text);
  expect(parsed).toEqual(result.structuredContent);
  if (!isRecord(parsed)) throw new Error(`Expected an object result from ${name}.`);
  return parsed;
}

async function callCapture(name: string, input: Record<string, unknown> = {}): Promise<ICapture> {
  const result = CallToolResultSchema.parse(await tools.call(name, input));
  const item = result.content.find(content => content.type === "image");
  if (!item || item.type !== "image") throw new Error(`Expected an image result from ${name}.`);
  expect(item.mimeType).toBe("image/png");
  return { frame: atob(item.data), structured: result.structuredContent };
}

async function callFrame(name: string, input: Record<string, unknown> = {}): Promise<string> {
  return (await callCapture(name, input)).frame;
}

function viewOf(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.view)) throw new Error("Expected a view object in the result.");
  return result.view;
}

function hostPreview(id: string): IHostPreview {
  const preview = host.Preview.all.find(candidate => candidate.id === id);
  if (!preview) throw new Error(`Missing host preview "${id}".`);
  return preview;
}

test("capture_screenshot renders the user's viewport gizmo-free and repaints it afterwards", async () => {
  expect(await callFrame("capture_screenshot")).toBe("main:1");
  expect(host.events).toEqual(["create:main", "gizmos:hidden", "render:main", "gizmos:restored", "render:main"]);
});

test("capture_screenshot targets the active pane by default and any connected viewport by Blockbench ID", async () => {
  const split = new host.Preview({ id: "split_screen_1" });
  host.Preview.selected = split;
  expect(await callFrame("capture_screenshot")).toBe("split_screen_1:1");
  expect(await callFrame("capture_screenshot", { view: "main" })).toBe("main:1");
  await expect(tools.call("capture_screenshot", { view: "ghost" })).rejects.toThrow(/Unknown view "ghost"/);
});

test("create_offscreen_view sizes the view, then copies the user's camera, and leaves the viewport untouched", async () => {
  host.main.camPers.position.fromArray([10, 20, 30]);
  const view = viewOf(await callJson("create_offscreen_view", { id: "inspect", width: 512, height: 512, antialias: false }));
  expect(view).toEqual({
    id: "inspect",
    kind: "offscreen",
    active: false,
    width: 512,
    height: 512,
    antialias: false,
    camera: { projection: "perspective", position: [10, 20, 30], target: [0, 8, 0], fov: 45, zoom: 0.5, locked_angle: null },
  });
  expect(host.events.slice(1)).toEqual([
    "create:mcp_offscreen_inspect",
    "resize:mcp_offscreen_inspect:512x512",
    "copy:mcp_offscreen_inspect<-main",
  ]);
  expect(host.Preview.selected).toBe(host.main);
  expect(host.main.presets).toEqual([]);
  expect(host.main.renders).toBe(0);
  const offscreen = hostPreview("mcp_offscreen_inspect");
  expect(offscreen.offscreen).toBe(true);
  expect(offscreen.antialias).toBe(false);
  expect(offscreen.canvas.isConnected).toBe(false);
});

test("create_offscreen_view applies defaults and validates IDs, sizes, and copy sources", async () => {
  expect(viewOf(await callJson("create_offscreen_view"))).toMatchObject({ id: "view_1", width: 1024, height: 768, antialias: true });
  expect(viewOf(await callJson("create_offscreen_view", { copy_view: "none" })).camera).toMatchObject({ position: [-80, 40, 80] });
  await expect(tools.call("create_offscreen_view", { id: "active" })).rejects.toThrow(/reserved/);
  await expect(tools.call("create_offscreen_view", { id: "main" })).rejects.toThrow(/Blockbench viewport/);
  await expect(tools.call("create_offscreen_view", { id: "view_1" })).rejects.toThrow(/already exists/);
  await expect(tools.call("create_offscreen_view", { id: "bad id!" })).rejects.toThrow();
  await expect(tools.call("create_offscreen_view", { width: 5 })).rejects.toThrow();
  await expect(tools.call("create_offscreen_view", { copy_view: "ghost" })).rejects.toThrow(/Unknown view "ghost"/);
});

test("set_camera_angle on an offscreen view moves only that camera and returns its frame with the camera state", async () => {
  await callJson("create_offscreen_view", { id: "inspect" });
  const start = host.events.length;
  const capture = await callCapture("set_camera_angle", {
    view: "inspect",
    position: [0, 50, 0],
    target: [0, 0, 0],
    projection: "orthographic",
    zoom: 2,
  });
  expect(capture.frame).toBe("mcp_offscreen_inspect:1");
  expect(viewOf(capture.structured)).toMatchObject({
    id: "inspect",
    camera: { projection: "orthographic", position: [0, 50, 0], target: [0, 0, 0], zoom: 2, locked_angle: null },
  });
  expect(host.events.slice(start)).toEqual([
    "angle:mcp_offscreen_inspect",
    "gizmos:hidden",
    "render:mcp_offscreen_inspect",
    "gizmos:restored",
  ]);
  expect(host.main.presets).toEqual([]);
  expect(host.main.renders).toBe(0);
  expect(host.main.camera.position.toArray()).toEqual([-80, 40, 80]);
  expect((await callJson("list_views")).views).toEqual([
    expect.objectContaining({ id: "main", kind: "viewport", active: true }),
    expect.objectContaining({ id: "inspect", kind: "offscreen", camera: expect.objectContaining({ projection: "orthographic" }) }),
  ]);
});

test("set_camera_angle locks side views only for orthographic projections", async () => {
  await callJson("create_offscreen_view", { id: "inspect" });
  const locked = await callCapture("set_camera_angle", {
    view: "inspect",
    position: [0, 50, 0],
    projection: "orthographic",
    locked_angle: "top",
  });
  expect(viewOf(locked.structured)).toMatchObject({ camera: { projection: "orthographic", locked_angle: "top" } });
  await expect(
    tools.call("set_camera_angle", { view: "inspect", position: [0, 50, 0], projection: "perspective", locked_angle: "top" })
  ).rejects.toThrow(/locked_angle requires/);
});

test("set_camera_angle still drives the user's viewport when no view is given", async () => {
  expect(await callFrame("set_camera_angle", { position: [1, 2, 3], projection: "perspective", fov: 30 })).toBe("main:1");
  expect(host.main.presets).toEqual([{ position: [1, 2, 3], projection: "perspective", fov: 30 }]);
  expect(host.main.camera.position.toArray()).toEqual([1, 2, 3]);
  expect(host.events.slice(1)).toEqual(["angle:main", "gizmos:hidden", "render:main", "gizmos:restored", "render:main"]);
});

test("capturing after a project switch restores the camera the agent gave an offscreen view", async () => {
  await callJson("create_offscreen_view", { id: "inspect" });
  await callCapture("set_camera_angle", { view: "inspect", position: [0, 50, 0], target: [0, 0, 0], projection: "orthographic" });
  // ModelProject#loadEditorState() re-targets every preview, offscreen ones included.
  hostPreview("mcp_offscreen_inspect").loadAnglePreset({ position: [-80, 40, 80], target: [0, 8, 0], projection: "perspective" });
  expect(await callFrame("capture_screenshot", { project: "Model", view: "inspect" })).toBe("mcp_offscreen_inspect:2");
  expect((await callJson("list_views")).views).toContainEqual(
    expect.objectContaining({ id: "inspect", camera: expect.objectContaining({ projection: "orthographic", position: [0, 50, 0] }) })
  );
});

test("resize_offscreen_view and delete_offscreen_view manage the view lifecycle", async () => {
  await callJson("create_offscreen_view", { id: "r" });
  expect(viewOf(await callJson("resize_offscreen_view", { view: "r", width: 256, height: 128 }))).toMatchObject({ width: 256, height: 128 });
  expect(await callFrame("capture_screenshot", { view: "r" })).toBe("mcp_offscreen_r:1");
  expect(host.events).toContain("resize:mcp_offscreen_r:256x128");
  expect(await callJson("delete_offscreen_view", { view: "r" })).toEqual({ deleted: "r", offscreen_views: 0 });
  expect(host.events).toContain("delete:mcp_offscreen_r");
  expect(host.Preview.all.map(preview => preview.id)).toEqual(["main"]);
  await expect(tools.call("capture_screenshot", { view: "r" })).rejects.toThrow(/Unknown view "r"/);
  await expect(tools.call("delete_offscreen_view", { view: "r" })).rejects.toThrow(/Unknown offscreen view/);
  await expect(tools.call("resize_offscreen_view", { view: "r", width: 64, height: 64 })).rejects.toThrow(/Unknown offscreen view/);
});

test("the offscreen view cap is enforced without leaking previews", async () => {
  await Promise.all(Array.from({ length: MAX_OFFSCREEN_VIEWS }, () => tools.call("create_offscreen_view", {})));
  await expect(tools.call("create_offscreen_view", {})).rejects.toThrow(new RegExp(`At most ${MAX_OFFSCREEN_VIEWS}`));
  expect(host.Preview.all.filter(preview => preview.offscreen)).toHaveLength(MAX_OFFSCREEN_VIEWS);
});
