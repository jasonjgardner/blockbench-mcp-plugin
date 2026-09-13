import { GEOMETRY_EPSILON } from "@/lib/constants";
import { type LiveSession, runLiveSuite, suiteArtifactPath } from "./harness";
import { canonical, numbers, record, records, sameCanonical, strings } from "./narrow";

// Creates a separate project. Run against the rebuilt desktop development plugin.

/** Extrusion depth requested from extrude_mesh and expected on every new cap vertex. */
const EXTRUSION_DISTANCE = 2.5;
/** Minimum +Z normal component for a subdivided triangle to count as keeping its winding. */
const NORMAL_ALIGNMENT_THRESHOLD = 0.99;
/** Page size large enough to inspect every face of the small test meshes at once. */
const INSPECTION_LIMIT = 500;
/** Texture created and painted by the native painter checks. */
const PAINT_PROBE = "Native Painter Probe";

/** Brush stroke whose connected samples must also paint pixel (7, 8) between its endpoints. */
const connectedBrushStroke = {
  texture_id: PAINT_PROBE,
  coordinates: [{ x: 4, y: 8 }, { x: 10, y: 8 }],
  brush_settings: { color: "#00ff00", size: 1, opacity: 255, softness: 0, shape: "square" },
  connect_strokes: true,
};

/** Two separate eraser dabs; without connection each records its own native undo entry. */
const disconnectedEraserPoints = {
  texture_id: PAINT_PROBE,
  coordinates: [{ x: 2, y: 2 }, { x: 12, y: 12 }],
  brush_size: 1, opacity: 255, softness: 0, connect_strokes: false,
};

/** Blockbench expression reading the RGBA value of the middle pixel painted by {@link connectedBrushStroke}. */
const brushMiddlePixelCode = `({pixel:Array.from(Texture.all.find(texture => texture.name === ${JSON.stringify(PAINT_PROBE)}).ctx.getImageData(7,8,1,1).data)})`;

/** Meshes created for this suite: UUIDs, the target quad's face key, and the unrelated quad's initial geometry. */
interface IActionFixture {
  mesh: string;
  otherMesh: string;
  triangleMesh: string;
  cap: string;
  untouched: Record<string, unknown>;
}

/** Geometry after a reversible operation plus the operation's own result. */
interface IReversibleOutcome<T> {
  geometry: Record<string, unknown>;
  result: T;
}

async function compareGeometry(session: LiveSession, actual: Record<string, unknown>, expected: Record<string, unknown>, label: string): Promise<void> {
  const matches = sameCanonical(actual, expected);
  if (!matches) await Bun.write(suiteArtifactPath("actions", "geometry-mismatch.json"), JSON.stringify({ label, expected, actual }, null, 2));
  session.check(matches, label);
}

async function geometry(session: LiveSession, mesh: string): Promise<Record<string, unknown>> {
  const element = records((await session.exportProject()).elements).find(item => item.uuid === mesh);
  if (!element) throw new Error(`Missing mesh ${mesh}`);
  return record(canonical({ vertices: element.vertices, faces: element.faces }));
}

function inspect(session: LiveSession, mesh: string): Promise<Record<string, unknown>> {
  return session.json("get_mesh_info", { mesh_id: mesh, include_uv: true, limit: INSPECTION_LIMIT });
}

async function textureBitmap(session: LiveSession): Promise<string> {
  const texture = records((await session.exportProject()).textures).find(item => item.name === PAINT_PROBE);
  if (!texture || typeof texture.source !== "string") throw new Error("Missing exported paint probe bitmap");
  return texture.source;
}

/** Raw `index` reported by get_undo_stack; callers compare it with `Number(before) + n`. */
async function undoIndex(session: LiveSession): Promise<unknown> {
  return (await session.json("get_undo_stack")).index;
}

async function select(session: LiveSession, mesh: string, mode = "face", elements?: string[]): Promise<void> {
  await session.call("select_mesh_elements", { mesh_id: mesh, mode, ...(elements ? { elements } : {}) });
}

function keyCount(value: unknown): number {
  return Object.keys(record(value)).length;
}

async function reversible<T>(session: LiveSession, mesh: string, label: string, operation: () => Promise<T>): Promise<IReversibleOutcome<T>> {
  const before = await geometry(session, mesh);
  const history = await undoIndex(session);
  const result = await operation();
  const after = await geometry(session, mesh);
  session.check(await undoIndex(session) === Number(history) + 1, `${label} records one edit`);
  await session.call("undo");
  await compareGeometry(session, await geometry(session, mesh), before, `${label} undo restores geometry and UVs`);
  await session.call("redo");
  await compareGeometry(session, await geometry(session, mesh), after, `${label} redo restores geometry and UVs`);
  return { geometry: after, result };
}

async function createFixture(session: LiveSession): Promise<IActionFixture> {
  await session.call("create_project", { name: "MCP Action Wrappers - Verified", format: "free" });
  const created = await session.json("place_mesh", { elements: [
    { name: "target quad", vertices: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]], faces: [[0, 1, 2, 3]] },
    { name: "unrelated quad", position: [12, 0, 0], vertices: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], faces: [[0, 1, 2, 3]] },
    { name: "target triangle", position: [-8, 0, 0], vertices: [[0, 0, 0], [3, 0, 0], [0, 3, 0]], faces: [[0, 1, 2]] },
  ] });
  const [target, other, triangle] = records(created.meshes);
  const otherMesh = String(other.uuid);
  return {
    mesh: String(target.uuid), otherMesh, triangleMesh: String(triangle.uuid),
    cap: strings(target.face_keys)[0], untouched: await geometry(session, otherMesh),
  };
}

async function extrusionScenario(session: LiveSession, { mesh, cap }: IActionFixture): Promise<void> {
  await select(session, mesh, "face", [cap]);
  const extruded = await reversible(session, mesh, "face extrusion",
    () => session.json("extrude_mesh", { mesh_id: mesh, distance: EXTRUSION_DISTANCE }));
  const positions = record(extruded.geometry.vertices);
  const liftedVertices = strings(extruded.result.vertex_keys);
  session.check(liftedVertices.every(key => Math.abs(numbers(positions[key])[2] - EXTRUSION_DISTANCE) < GEOMETRY_EPSILON),
    `extrusion honors requested distance ${EXTRUSION_DISTANCE}`);
  session.check(keyCount(extruded.geometry.faces) === 5 && Object.keys(positions).length === 8, "extrusion creates one cap and four boundary walls");
  session.check(strings(extruded.result.face_keys).includes(cap), "extrusion retains original cap face ID");
}

async function subdivisionScenario(session: LiveSession, { mesh, triangleMesh, cap }: IActionFixture): Promise<string[]> {
  await select(session, mesh, "face", [cap]);
  const divided = await reversible(session, mesh, "quad subdivision", () => session.json("subdivide_mesh", { mesh_id: mesh, cuts: 2 }));
  const capFaces = strings(divided.result.face_keys);
  session.check(capFaces.length === 9 && keyCount(divided.geometry.faces) === 13, "two cuts create nine cap quads and retain four walls");
  await select(session, triangleMesh);
  const triangle = await reversible(session, triangleMesh, "triangle subdivision",
    () => session.call("subdivide_mesh", { mesh_id: triangleMesh, cuts: 2 }));
  session.check(keyCount(triangle.geometry.faces) === 9, "triangle subdivision also honors cuts");
  const triangleFaces = records(record((await inspect(session, triangleMesh)).faces).items);
  session.check(triangleFaces.every(face => numbers(face.normal)[2] > NORMAL_ALIGNMENT_THRESHOLD), "subdivided triangle normals preserve winding");
  return capFaces;
}

async function uvScenario(session: LiveSession, { mesh, otherMesh, untouched }: IActionFixture, mappedFaces: string[]): Promise<void> {
  const firstFaces = mappedFaces.slice(0, 2);
  await select(session, otherMesh);
  const selectionBeforeUV = await session.json("get_selection");
  await reversible(session, mesh, "planar unwrap", () => session.call("auto_uv_mesh", { mesh_id: mesh, faces: mappedFaces, mode: "unwrap" }));
  await session.call("set_camera_angle", { position: [12, 10, 25], target: [2, 2, 1], projection: "perspective" });
  await reversible(session, mesh, "project UV", () => session.call("auto_uv_mesh", { mesh_id: mesh, faces: firstFaces, mode: "project" }));
  await reversible(session, mesh, "rotate UV", () => session.call("rotate_mesh_uv", { mesh_id: mesh, faces: firstFaces, angle: "90" }));
  session.check(JSON.stringify(await geometry(session, otherMesh)) === JSON.stringify(untouched),
    "targeted geometry and UV operations preserve unrelated selected mesh");
  session.check(JSON.stringify(await session.json("get_selection")) === JSON.stringify(selectionBeforeUV),
    "explicit UV targets preserve object and component selection");
  const faces = records(record((await inspect(session, mesh)).faces).items);
  session.check(faces.every(face => Object.values(record(face.uv)).every(uv => Array.isArray(uv) && uv.every(Number.isFinite))),
    "UV mapping produces finite coordinates");
}

async function deletionScenario(session: LiveSession, { mesh, triangleMesh }: IActionFixture, mappedFaces: string[]): Promise<void> {
  await select(session, mesh, "face", [mappedFaces[0]]);
  const vertexCount = keyCount((await geometry(session, mesh)).vertices);
  const kept = await reversible(session, mesh, "face deletion with retained vertices",
    () => session.call("delete_mesh_elements", { mesh_id: mesh, mode: "faces", keep_vertices: true }));
  session.check(keyCount(kept.geometry.vertices) === vertexCount && !Object.hasOwn(record(kept.geometry.faces), mappedFaces[0]),
    "keep_vertices retains face vertices while removing requested face");
  await select(session, triangleMesh);
  const deleted = await reversible(session, triangleMesh, "face deletion with orphan cleanup",
    () => session.call("delete_mesh_elements", { mesh_id: triangleMesh, mode: "faces", keep_vertices: false }));
  session.check(keyCount(deleted.geometry.faces) === 0 && keyCount(deleted.geometry.vertices) === 0, "keep_vertices false removes orphaned vertices");
}

async function evalAndNativeUndoScenario(session: LiveSession, { triangleMesh }: IActionFixture): Promise<void> {
  const historyBeforeEval = await session.json("get_undo_stack");
  const evaluated = await session.json("risky_eval", { code: "({version: Blockbench.version, undo_index: Undo.index})" });
  session.check(typeof evaluated.version === "string" && evaluated.undo_index === historyBeforeEval.index, "read-only eval returns desktop data");
  session.check(JSON.stringify(await session.json("get_undo_stack")) === JSON.stringify(historyBeforeEval), "read-only eval creates no empty Undo entry");
  const beforeNativeRedo = await geometry(session, triangleMesh);
  await session.call("trigger_action", { action: "undo", confirmDialog: false });
  session.check(keyCount((await geometry(session, triangleMesh)).faces) === 9, "trigger_action delegates undo to the native Action");
  await session.call("trigger_action", { action: "redo", confirmDialog: false });
  session.check(JSON.stringify(await geometry(session, triangleMesh)) === JSON.stringify(beforeNativeRedo),
    "trigger_action delegates redo without a nested Undo edit");
  session.check(JSON.stringify(await session.json("get_undo_stack")) === JSON.stringify(historyBeforeEval),
    "native undo/redo dispatch preserves history entries");
}

async function mutationState(session: LiveSession, mesh: string): Promise<string> {
  return JSON.stringify({ mesh: await inspect(session, mesh), selection: await session.json("get_selection"), history: await session.json("get_undo_stack") });
}

async function invalidRequestScenario(session: LiveSession, { mesh }: IActionFixture): Promise<void> {
  const beforeErrors = await mutationState(session, mesh);
  await session.expectRejected([
    { name: "extrude_mesh", arguments: { mesh_id: mesh, mode: "edges", distance: 1 } },
    { name: "knife_tool", arguments: { mesh_id: mesh, points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] } },
    { name: "subdivide_mesh", arguments: { mesh_id: mesh, cuts: 1.5 } },
    { name: "auto_uv_mesh", arguments: { mesh_id: mesh, faces: ["__missing__"], mode: "unwrap" } },
    { name: "trigger_action", arguments: { action: "__missing__" } },
    { name: "trigger_action", arguments: { action: "undo", confirmEvent: "null" } },
  ], "rejects unsupported or invalid request");
  session.check(await mutationState(session, mesh) === beforeErrors, "invalid calls preserve mesh, selection, and history");
}

async function fillScenario(session: LiveSession): Promise<string> {
  await session.call("create_texture", { name: PAINT_PROBE, width: 16, height: 16, fill_color: "#ffffff", layer_name: "Base" });
  await session.call("risky_eval", { code: "Modes.options.paint.select(); ({mode: Modes.selected.id})" });
  const originalBitmap = await textureBitmap(session);
  const beforeFill = await session.json("get_undo_stack");
  const fill = { texture_id: PAINT_PROBE, x: 1, y: 1, color: "#ff0000", opacity: 255 };
  const tolerance = await session.attempt("paint_fill_tool", { ...fill, tolerance: 25 });
  session.check(tolerance.isError && await textureBitmap(session) === originalBitmap
    && JSON.stringify(await session.json("get_undo_stack")) === JSON.stringify(beforeFill), "unsupported fill tolerance preserves pixels and history");
  await session.call("paint_fill_tool", { ...fill, fill_mode: "color_connected" });
  const paintedBitmap = await textureBitmap(session);
  session.check(paintedBitmap !== originalBitmap, "native fill modifies the requested texture bitmap");
  session.check(await undoIndex(session) === Number(beforeFill.index) + 1, "native fill records one undo entry without nesting");
  await session.call("undo");
  session.check(await textureBitmap(session) === originalBitmap, "native fill undo restores texture pixels");
  await session.call("redo");
  session.check(await textureBitmap(session) === paintedBitmap, "native fill redo restores texture pixels");
  return paintedBitmap;
}

async function brushScenario(session: LiveSession, paintedBitmap: string): Promise<void> {
  const beforeBrush = await undoIndex(session);
  await session.call("paint_with_brush", connectedBrushStroke);
  const brushPixel = await session.json("risky_eval", { code: brushMiddlePixelCode });
  session.check(JSON.stringify(brushPixel.pixel) === "[0,255,0,255]", "connected brush samples paint the middle pixel between endpoints");
  session.check(await undoIndex(session) === Number(beforeBrush) + 1, "connected brush owns one Texture.edit undo entry");
  await session.call("undo");
  session.check(await textureBitmap(session) === paintedBitmap, "connected brush undo restores the original bitmap");
}

async function eraserScenario(session: LiveSession, paintedBitmap: string): Promise<void> {
  const beforeErase = await undoIndex(session);
  await session.call("eraser_tool", disconnectedEraserPoints);
  const erasedBitmap = await textureBitmap(session);
  session.check(erasedBitmap !== paintedBitmap, "disconnected eraser points modify the bitmap");
  session.check(await undoIndex(session) === Number(beforeErase) + 2, "disconnected eraser points have two balanced native undo entries");
  await session.call("undo", { steps: 2 });
  session.check(await textureBitmap(session) === paintedBitmap, "undoing both erase strokes restores all pixels");
  await session.call("redo", { steps: 2 });
  session.check(await textureBitmap(session) === erasedBitmap, "redoing both erase strokes restores their result");
  const painterState = await session.json("risky_eval", { code: "({pending_edit: !!Undo.current_save})" });
  session.check(painterState.pending_edit === false, "native painter wrappers leave no pending undo snapshot");
  await session.call("risky_eval", { code: "Modes.options.edit.select(); ({mode: Modes.selected.id})" });
}

async function actionWrappersSuite(session: LiveSession): Promise<void> {
  const fixture = await createFixture(session);
  await extrusionScenario(session, fixture);
  const mappedFaces = await subdivisionScenario(session, fixture);
  await uvScenario(session, fixture, mappedFaces);
  await deletionScenario(session, fixture, mappedFaces);
  await evalAndNativeUndoScenario(session, fixture);
  await invalidRequestScenario(session, fixture);
  const paintedBitmap = await fillScenario(session);
  await brushScenario(session, paintedBitmap);
  await eraserScenario(session, paintedBitmap);
  const exported = await session.exportProjectText("final desktop project exports completely");
  await Bun.write(suiteArtifactPath("actions", "action-wrappers.bbmodel"), exported);
  await session.writeResults("actions", checks => ({ endpoint: session.endpoint.href, checks }));
  console.log(`Completed ${session.checks.length} desktop action-wrapper checks.`);
}

await runLiveSuite("blockbench-action-wrappers-smoke", actionWrappersSuite);
