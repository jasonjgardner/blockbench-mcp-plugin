import { type LiveSession, runLiveSuite, suiteArtifactPath } from "./harness";
import { createIdentityMeshes } from "./identity-geometry";
import { numbers, record, records, strings } from "./narrow";

// Run only against a running development plugin. Creates a separate test project.

/** Minimum tool count proving the full modeling tool set is registered, not a partial load. */
const MIN_MODELING_TOOLS = 100;
/** Texture applied to the logo meshes. */
const PORCELAIN = "MCP Porcelain";
/** Evidence label recorded (once) for every complete project export. */
const EXPORT_COMPLETE_LABEL = "project export is complete";

/** Discovery counts written to the result file. */
interface IDiscovery {
  tools: number;
  resources: number;
  prompts: number;
}

/** Triangle with position, rotation and non-uniform scale, used to verify transform handling. */
const transformProbe = {
  name: "transform probe", position: [5, 7, 2], rotation: [0, 0, 30], scale: [2, 2, 1],
  vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], faces: [[0, 1, 2]],
};

function meshFrom(model: Record<string, unknown>, name: string): Record<string, unknown> {
  const elements = model.elements;
  if (!Array.isArray(elements)) throw new Error("Missing exported elements");
  const mesh = records(elements, "exported elements").find(element => element.name === name);
  if (!mesh) throw new Error(`Missing exported mesh ${name}`);
  return mesh;
}

async function exportedMesh(session: LiveSession, name: string): Promise<Record<string, unknown>> {
  return meshFrom(await session.exportProject(EXPORT_COMPLETE_LABEL), name);
}

async function projectCounts(session: LiveSession): Promise<Record<string, unknown>> {
  return record((await session.json("get_project_info")).counts);
}

async function saveScreenshot(session: LiveSession, name: string): Promise<void> {
  const result = await session.call("capture_screenshot");
  const data = records(result.content, "capture_screenshot content")
    .find(item => item.type === "image" && item.mimeType === "image/png" && typeof item.data === "string")?.data;
  session.check(typeof data === "string" && data.length > 0, `${name} screenshot returned PNG data`);
  await Bun.write(suiteArtifactPath("identity", name), Uint8Array.fromBase64(data));
}

/** True when the face normal (from its first three vertices) points away from the mesh origin. */
function faceNormalPointsOutward(value: unknown, positions: Record<string, unknown>): boolean {
  const points = strings(record(value).vertices, "face vertices").map(key => numbers(positions[key], `vertex ${key}`));
  const [a, b, c] = points;
  const u = b.map((coordinate, axis) => coordinate - a[axis]);
  const v = c.map((coordinate, axis) => coordinate - a[axis]);
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const center = [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
  return normal.reduce((sum, component, axis) => sum + component * center[axis], 0) > 0;
}

async function discoveryScenario(session: LiveSession): Promise<IDiscovery> {
  const tools = await session.client.listTools();
  session.check(tools.tools.length > MIN_MODELING_TOOLS, "tool discovery exposes modeling capabilities");
  session.check(tools.tools.find(tool => tool.name === "get_project_info")?.annotations?.readOnlyHint, "read-only annotation is advertised");
  const resources = await session.client.listResources();
  const templates = await session.client.listResourceTemplates();
  const prompts = await session.client.listPrompts();
  session.check(templates.resourceTemplates.length > 0, "resource templates are discoverable");
  session.check(prompts.prompts.length > 0, "prompts are discoverable");
  const discovery = { tools: tools.tools.length, resources: resources.resources.length, prompts: prompts.prompts.length };
  // The round trip needs a project that was already open; this suite only creates its own project afterwards.
  const initialProjectResource = resources.resources.find(resource => resource.uri.startsWith("projects://"));
  if (!initialProjectResource) {
    console.log("SKIP project resource round trip succeeds: no projects:// resource was open before the suite started");
    return discovery;
  }
  const read = await session.client.readResource({ uri: initialProjectResource.uri });
  session.check(read.contents.length > 0, "project resource round trip succeeds");
  return discovery;
}

async function transformProbeScenario(session: LiveSession): Promise<void> {
  await session.call("create_project", { name: "MCP Identity Mark - Verified", format: "free" });
  await session.call("save_checkpoint", { name: "Before verified identity test" });
  const created = await session.json("place_mesh", { elements: [transformProbe] });
  session.check(Array.isArray(created.meshes), "mesh creation returns structured key mappings without a texture");
  const createdMesh = record(records(created.meshes)[0], "place_mesh meshes[0]");
  session.check(Array.isArray(createdMesh.vertex_keys) && createdMesh.vertex_keys.length === 3, "input vertex order is mapped to keys");
  const before = await exportedMesh(session, transformProbe.name);
  session.check(JSON.stringify(before.origin) === "[5,7,2]", "mesh position is preserved");
  session.check(JSON.stringify(before.rotation) === "[0,0,30]", "mesh rotation is preserved");
  session.check(Object.values(record(before.vertices)).some(vertex => JSON.stringify(vertex) === "[4,0,0]"), "scale is baked into mesh coordinates");
  session.check(Object.keys(record(before.faces)).length === 1, "indexed triangle is created");
  await session.call("undo");
  session.check((await projectCounts(session)).meshes === 0, "mesh undo removes all elements");
  await session.call("redo");
  session.check((await projectCounts(session)).meshes === 1, "mesh redo restores element");
  await session.call("select_mesh_elements", { mesh_id: transformProbe.name, mode: "vertex" });
  await session.call("move_mesh_vertices", { mesh_id: transformProbe.name, offset: [0, 1, 0] });
  const moved = await exportedMesh(session, transformProbe.name);
  session.check(Object.values(record(moved.vertices)).some(vertex => JSON.stringify(vertex) === "[4,1,0]"), "stored vertex selection drives subsequent edits");
  await session.call("remove_element", { id: transformProbe.name });
}

async function invalidStateScenario(session: LiveSession): Promise<void> {
  const history = await session.json("get_undo_stack");
  const invalid = await session.attempt("place_mesh", {
    elements: [{ name: "invalid", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 9]] }],
  });
  session.check(invalid.isError, "invalid vertex index is rejected");
  session.check((await projectCounts(session)).meshes === 0, "invalid mesh creates no partial elements");
  session.check(JSON.stringify(await session.json("get_undo_stack")) === JSON.stringify(history), "invalid mesh leaves undo unchanged");
  const invalidTexture = await session.attempt("create_texture", { name: "invalid texture", width: 16, height: 16, fill_color: "#ffffff" });
  session.check(invalidTexture.isError, "texture cross-field refinement is enforced");
  session.check((await projectCounts(session)).textures === 0, "invalid texture leaves no state");
  await session.call("create_texture", { name: PORCELAIN, width: 16, height: 16, fill_color: "#f3f0e9", layer_name: "Base", render_sides: "front" });
  await session.call("undo");
  session.check((await projectCounts(session)).textures === 0, "texture undo removes created texture");
  await session.call("redo");
  session.check((await projectCounts(session)).textures === 1, "texture redo restores created texture");
}

async function cylinderScenario(session: LiveSession): Promise<void> {
  await session.call("create_cylinder", { elements: [{ name: "normal probe", position: [0, 0, 0], diameter: 8, height: 2, sides: 8 }], texture: PORCELAIN });
  const cylinder = await exportedMesh(session, "normal probe");
  const positions = record(cylinder.vertices);
  session.check(Object.values(record(cylinder.faces)).every(face => faceNormalPointsOutward(face, positions)), "every cylinder face points outward");
  await session.call("undo");
  session.check((await projectCounts(session)).meshes === 0, "cylinder undo removes created mesh");
}

async function logoScenario(session: LiveSession): Promise<(string | number)[][]> {
  await session.call("add_group", { name: "MCP Identity Mark", origin: [0, 18, 0] });
  const meshes = createIdentityMeshes();
  await session.call("place_mesh", { elements: meshes, texture: PORCELAIN, group: "MCP Identity Mark" });
  const model = await session.exportProject(EXPORT_COMPLETE_LABEL);
  const textures = Array.isArray(model.textures) ? records(model.textures, "exported textures") : [];
  session.check(textures.find(texture => texture.name === PORCELAIN), "porcelain texture survives project export");
  session.check(meshes.every(mesh => {
    const exported = meshFrom(model, mesh.name);
    return Object.keys(record(exported.vertices)).length === mesh.vertices.length && Object.keys(record(exported.faces)).length === mesh.faces.length;
  }), "all logo geometry survives project export");
  session.check(meshes.every(mesh => Object.values(record(meshFrom(model, mesh.name).faces)).every(face => record(face).texture === 0)),
    "every logo face references the supplied texture");
  await session.call("undo");
  session.check((await projectCounts(session)).meshes === 0, "batch logo undo removes three meshes");
  await session.call("redo");
  session.check((await projectCounts(session)).meshes === 3, "batch logo redo restores three meshes");
  return meshes.map(mesh => [mesh.name, mesh.vertices.length, mesh.faces.length]);
}

async function previewAndExportScenario(session: LiveSession): Promise<void> {
  await session.call("set_camera_angle", { position: [0, 18, 66], target: [0, 18, 0], projection: "perspective" });
  await saveScreenshot(session, "front.png");
  await session.call("set_camera_angle", { position: [22, 26, 65], target: [0, 18, 0], projection: "perspective" });
  await saveScreenshot(session, "perspective.png");
  const formats = await session.json("list_export_formats", { only_current_format: true });
  session.check(Array.isArray(formats.codecs) && formats.codecs.some((codec: unknown) => record(codec).id === "project"), "project export codec is discoverable");
  const exported = await session.exportProjectText("final bbmodel export is complete");
  await Bun.write(suiteArtifactPath("identity", "mcp-identity.bbmodel"), exported);
}

async function identitySuite(session: LiveSession): Promise<void> {
  const discovery = await discoveryScenario(session);
  await transformProbeScenario(session);
  await invalidStateScenario(session);
  await cylinderScenario(session);
  const geometry = await logoScenario(session);
  await previewAndExportScenario(session);
  await session.writeResults("identity", checks => ({ endpoint: session.endpoint.href, checks, ...discovery, geometry }));
  console.log(`Completed ${session.checks.length} checks; saved model and previews to ${suiteArtifactPath("identity")}`);
}

await runLiveSuite("blockbench-identity-smoke", identitySuite);
