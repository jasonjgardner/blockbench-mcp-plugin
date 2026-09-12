import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Creates a separate project. Run against the rebuilt desktop development plugin.
const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const client = new Client({ name: "blockbench-action-wrappers-smoke", version: "1.0.0" });
const checks: string[] = [];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Expected string keys");
  return value as string[];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
}
async function compareGeometry(actual: Record<string, unknown>, expected: Record<string, unknown>, label: string): Promise<void> {
  const matches = JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
  if (!matches) await Bun.write(new URL("../../artifacts/action-wrappers/geometry-mismatch.json", import.meta.url), JSON.stringify({ label, expected, actual }, null, 2));
  check(matches, label);
}
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks.push(label);
  console.log(`PASS ${label}`);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}
async function json(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  const text = records(result.content).find(item => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${name} returned no JSON text`);
  return record(JSON.parse(text));
}
async function geometry(mesh: string): Promise<Record<string, unknown>> {
  const exported = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  if (exported.truncated || typeof exported.content !== "string") throw new Error("Project export is truncated");
  const model = record(JSON.parse(exported.content));
  const element = records(model.elements).find(item => item.uuid === mesh);
  if (!element) throw new Error(`Missing mesh ${mesh}`);
  return record(canonical({ vertices: element.vertices, faces: element.faces }));
}
async function inspect(mesh: string): Promise<Record<string, unknown>> {
  return json("get_mesh_info", { mesh_id: mesh, include_uv: true, limit: 500 });
}
async function textureBitmap(): Promise<string> {
  const exported = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  if (exported.truncated || typeof exported.content !== "string") throw new Error("Project export is truncated");
  const texture = records(record(JSON.parse(exported.content)).textures).find(item => item.name === "Native Painter Probe");
  if (!texture || typeof texture.source !== "string") throw new Error("Missing exported paint probe bitmap");
  return texture.source;
}
async function select(mesh: string, mode = "face", elements?: string[]): Promise<void> {
  await call("select_mesh_elements", { mesh_id: mesh, mode, ...(elements ? { elements } : {}) });
}
async function reversible(mesh: string, label: string, operation: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const before = await geometry(mesh);
  const history = await json("get_undo_stack");
  await operation();
  const after = await geometry(mesh);
  check((await json("get_undo_stack")).index === Number(history.index) + 1, `${label} records one edit`);
  await call("undo");
  await compareGeometry(await geometry(mesh), before, `${label} undo restores geometry and UVs`);
  await call("redo");
  await compareGeometry(await geometry(mesh), after, `${label} redo restores geometry and UVs`);
  return after;
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  await call("create_project", { name: "MCP Action Wrappers - Verified", format: "free" });
  const created = await json("place_mesh", { elements: [
    { name: "target quad", vertices: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]], faces: [[0, 1, 2, 3]] },
    { name: "unrelated quad", position: [12, 0, 0], vertices: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], faces: [[0, 1, 2, 3]] },
    { name: "target triangle", position: [-8, 0, 0], vertices: [[0, 0, 0], [3, 0, 0], [0, 3, 0]], faces: [[0, 1, 2]] },
  ] });
  const [target, other, triangle] = records(created.meshes);
  const mesh = String(target.uuid);
  const otherMesh = String(other.uuid);
  const triangleMesh = String(triangle.uuid);
  const cap = strings(target.face_keys)[0];
  const untouched = await geometry(otherMesh);

  await select(mesh, "face", [cap]);
  let extrusion: Record<string, unknown> = {};
  const extruded = await reversible(mesh, "face extrusion", async () => {
    extrusion = await json("extrude_mesh", { mesh_id: mesh, distance: 2.5 });
  });
  const positions = record(extruded.vertices);
  check(strings(extrusion.vertex_keys).every(key => Math.abs((positions[key] as number[])[2] - 2.5) < 1e-8), "extrusion honors requested distance 2.5");
  check(Object.keys(record(extruded.faces)).length === 5 && Object.keys(positions).length === 8, "extrusion creates one cap and four boundary walls");
  check(strings(extrusion.face_keys).includes(cap), "extrusion retains original cap face ID");

  await select(mesh, "face", [cap]);
  let subdivision: Record<string, unknown> = {};
  const divided = await reversible(mesh, "quad subdivision", async () => {
    subdivision = await json("subdivide_mesh", { mesh_id: mesh, cuts: 2 });
  });
  check(strings(subdivision.face_keys).length === 9 && Object.keys(record(divided.faces)).length === 13, "two cuts create nine cap quads and retain four walls");
  await select(triangleMesh);
  const triangleResult = await reversible(triangleMesh, "triangle subdivision", () => call("subdivide_mesh", { mesh_id: triangleMesh, cuts: 2 }));
  check(Object.keys(record(triangleResult.faces)).length === 9, "triangle subdivision also honors cuts");
  check(records(record((await inspect(triangleMesh)).faces).items).every(face => (face.normal as number[])[2] > 0.99), "subdivided triangle normals preserve winding");

  const mappedFaces = strings(subdivision.face_keys);
  await select(otherMesh);
  const selectionBeforeUV = await json("get_selection");
  await reversible(mesh, "planar unwrap", () => call("auto_uv_mesh", { mesh_id: mesh, faces: mappedFaces, mode: "unwrap" }));
  await call("set_camera_angle", { position: [12, 10, 25], target: [2, 2, 1], projection: "perspective" });
  await reversible(mesh, "project UV", () => call("auto_uv_mesh", { mesh_id: mesh, faces: mappedFaces.slice(0, 2), mode: "project" }));
  await reversible(mesh, "rotate UV", () => call("rotate_mesh_uv", { mesh_id: mesh, faces: mappedFaces.slice(0, 2), angle: "90" }));
  check(JSON.stringify(await geometry(otherMesh)) === JSON.stringify(untouched), "targeted geometry and UV operations preserve unrelated selected mesh");
  check(JSON.stringify(await json("get_selection")) === JSON.stringify(selectionBeforeUV), "explicit UV targets preserve object and component selection");
  check(records(record((await inspect(mesh)).faces).items).every(face => Object.values(record(face.uv)).every(uv => Array.isArray(uv) && uv.every(Number.isFinite))), "UV mapping produces finite coordinates");

  await select(mesh, "face", [mappedFaces[0]]);
  const vertexCount = Object.keys(record((await geometry(mesh)).vertices)).length;
  const kept = await reversible(mesh, "face deletion with retained vertices", () => call("delete_mesh_elements", { mesh_id: mesh, mode: "faces", keep_vertices: true }));
  check(Object.keys(record(kept.vertices)).length === vertexCount && !Object.hasOwn(record(kept.faces), mappedFaces[0]), "keep_vertices retains face vertices while removing requested face");
  await select(triangleMesh);
  const deleted = await reversible(triangleMesh, "face deletion with orphan cleanup", () => call("delete_mesh_elements", { mesh_id: triangleMesh, mode: "faces", keep_vertices: false }));
  check(Object.keys(record(deleted.faces)).length === 0 && Object.keys(record(deleted.vertices)).length === 0, "keep_vertices false removes orphaned vertices");

  const historyBeforeEval = await json("get_undo_stack");
  const evaluated = await json("risky_eval", { code: "({version: Blockbench.version, undo_index: Undo.index})" });
  check(typeof evaluated.version === "string" && evaluated.undo_index === historyBeforeEval.index, "read-only eval returns desktop data");
  check(JSON.stringify(await json("get_undo_stack")) === JSON.stringify(historyBeforeEval), "read-only eval creates no empty Undo entry");

  const beforeNativeRedo = await geometry(triangleMesh);
  await call("trigger_action", { action: "undo", confirmDialog: false });
  check(Object.keys(record((await geometry(triangleMesh)).faces)).length === 9, "trigger_action delegates undo to the native Action");
  await call("trigger_action", { action: "redo", confirmDialog: false });
  check(JSON.stringify(await geometry(triangleMesh)) === JSON.stringify(beforeNativeRedo), "trigger_action delegates redo without a nested Undo edit");
  check(JSON.stringify(await json("get_undo_stack")) === JSON.stringify(historyBeforeEval), "native undo/redo dispatch preserves history entries");

  const beforeErrors = JSON.stringify({ mesh: await inspect(mesh), selection: await json("get_selection"), history: await json("get_undo_stack") });
  const invalid = [
    { name: "extrude_mesh", arguments: { mesh_id: mesh, mode: "edges", distance: 1 } },
    { name: "knife_tool", arguments: { mesh_id: mesh, points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] } },
    { name: "subdivide_mesh", arguments: { mesh_id: mesh, cuts: 1.5 } },
    { name: "auto_uv_mesh", arguments: { mesh_id: mesh, faces: ["__missing__"], mode: "unwrap" } },
    { name: "trigger_action", arguments: { action: "__missing__" } },
    { name: "trigger_action", arguments: { action: "undo", confirmEvent: "null" } },
  ];
  for (const request of invalid) check((await client.callTool(request)).isError, `${request.name} rejects unsupported or invalid request`);
  check(JSON.stringify({ mesh: await inspect(mesh), selection: await json("get_selection"), history: await json("get_undo_stack") }) === beforeErrors, "invalid calls preserve mesh, selection, and history");
  await call("create_texture", { name: "Native Painter Probe", width: 16, height: 16, fill_color: "#ffffff", layer_name: "Base" });
  await call("risky_eval", { code: "Modes.options.paint.select(); ({mode: Modes.selected.id})" });
  const originalBitmap = await textureBitmap();
  const beforeFill = await json("get_undo_stack");
  const tolerance = await client.callTool({ name: "paint_fill_tool", arguments: { texture_id: "Native Painter Probe", x: 1, y: 1, color: "#ff0000", opacity: 255, tolerance: 25 } });
  check(tolerance.isError && await textureBitmap() === originalBitmap && JSON.stringify(await json("get_undo_stack")) === JSON.stringify(beforeFill), "unsupported fill tolerance preserves pixels and history");
  await call("paint_fill_tool", { texture_id: "Native Painter Probe", x: 1, y: 1, color: "#ff0000", opacity: 255, fill_mode: "color_connected" });
  const paintedBitmap = await textureBitmap();
  check(paintedBitmap !== originalBitmap, "native fill modifies the requested texture bitmap");
  check((await json("get_undo_stack")).index === Number(beforeFill.index) + 1, "native fill records one undo entry without nesting");
  await call("undo");
  check(await textureBitmap() === originalBitmap, "native fill undo restores texture pixels");
  await call("redo");
  check(await textureBitmap() === paintedBitmap, "native fill redo restores texture pixels");
  const beforeBrush = await json("get_undo_stack");
  await call("paint_with_brush", { texture_id: "Native Painter Probe", coordinates: [{ x: 4, y: 8 }, { x: 10, y: 8 }], brush_settings: { color: "#00ff00", size: 1, opacity: 255, softness: 0, shape: "square" }, connect_strokes: true });
  const brushPixel = await json("risky_eval", { code: '({pixel:Array.from(Texture.all.find(texture => texture.name === "Native Painter Probe").ctx.getImageData(7,8,1,1).data)})' });
  check(JSON.stringify(brushPixel.pixel) === "[0,255,0,255]", "connected brush samples paint the middle pixel between endpoints");
  check((await json("get_undo_stack")).index === Number(beforeBrush.index) + 1, "connected brush owns one Texture.edit undo entry");
  await call("undo");
  check(await textureBitmap() === paintedBitmap, "connected brush undo restores the original bitmap");
  const beforeErase = await json("get_undo_stack");
  await call("eraser_tool", { texture_id: "Native Painter Probe", coordinates: [{ x: 2, y: 2 }, { x: 12, y: 12 }], brush_size: 1, opacity: 255, softness: 0, connect_strokes: false });
  const erasedBitmap = await textureBitmap();
  check(erasedBitmap !== paintedBitmap, "disconnected eraser points modify the bitmap");
  check((await json("get_undo_stack")).index === Number(beforeErase.index) + 2, "disconnected eraser points have two balanced native undo entries");
  await call("undo", { steps: 2 });
  check(await textureBitmap() === paintedBitmap, "undoing both erase strokes restores all pixels");
  await call("redo", { steps: 2 });
  check(await textureBitmap() === erasedBitmap, "redoing both erase strokes restores their result");
  const painterState = await json("risky_eval", { code: "({pending_edit: !!Undo.current_save})" });
  check(painterState.pending_edit === false, "native painter wrappers leave no pending undo snapshot");
  await call("risky_eval", { code: "Modes.options.edit.select(); ({mode: Modes.selected.id})" });
  const exported = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  check(!exported.truncated && typeof exported.content === "string", "final desktop project exports completely");
  await Bun.write(new URL("../../artifacts/action-wrappers/action-wrappers.bbmodel", import.meta.url), String(exported.content));
  await Bun.write(new URL("../../artifacts/action-wrappers/smoke-results.json", import.meta.url), JSON.stringify({ endpoint: endpoint.href, checks }, null, 2));
  console.log(`Completed ${checks.length} desktop action-wrapper checks.`);
} finally {
  await client.close();
}
