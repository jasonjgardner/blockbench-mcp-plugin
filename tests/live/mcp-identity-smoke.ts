import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIdentityMeshes } from "./identity-geometry";

// Run only against a running development plugin. Creates a separate test project.
const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const output = new URL("../../artifacts/mcp-identity/", import.meta.url);
const client = new Client({ name: "blockbench-identity-smoke", version: "1.0.0" });
const checks: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
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
  const content = result.content as { type: string; text?: string }[];
  const text = content.find(item => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no JSON text`);
  return record(JSON.parse(text));
}

async function project(): Promise<Record<string, unknown>> {
  const result = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  check(!result.truncated, "project export is complete");
  return record(JSON.parse(String(result.content)));
}

function meshFrom(model: Record<string, unknown>, name: string): Record<string, unknown> {
  const elements = model.elements;
  if (!Array.isArray(elements)) throw new Error("Missing exported elements");
  const mesh = elements.map(record).find(element => element.name === name);
  if (!mesh) throw new Error(`Missing exported mesh ${name}`);
  return mesh;
}

async function saveScreenshot(name: string): Promise<void> {
  const result = await call("capture_screenshot");
  const blocks = result.content as { type: string; data?: string; mimeType?: string }[];
  const screenshot = blocks.find(item => item.type === "image" && item.mimeType === "image/png");
  check(screenshot?.data, `${name} screenshot returned PNG data`);
  await Bun.write(new URL(name, output), Buffer.from(screenshot.data, "base64"));
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const tools = await client.listTools();
  check(tools.tools.length > 100, "tool discovery exposes modeling capabilities");
  check(tools.tools.find(tool => tool.name === "get_project_info")?.annotations?.readOnlyHint,
    "read-only annotation is advertised");
  const resources = await client.listResources();
  const templates = await client.listResourceTemplates();
  const prompts = await client.listPrompts();
  check(templates.resourceTemplates.length > 0, "resource templates are discoverable");
  check(prompts.prompts.length > 0, "prompts are discoverable");
  const initialProjectResource = resources.resources.find(resource => resource.uri.startsWith("projects://"));
  if (initialProjectResource) {
    const read = await client.readResource({ uri: initialProjectResource.uri });
    check(read.contents.length > 0, "project resource round trip succeeds");
  }
  await call("create_project", { name: "MCP Identity Mark - Verified", format: "free" });
  await call("save_checkpoint", { name: "Before verified identity test" });

  const probe = { name: "transform probe", position: [5, 7, 2], rotation: [0, 0, 30], scale: [2, 2, 1],
    vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], faces: [[0, 1, 2]] };
  const created = await json("place_mesh", { elements: [probe] });
  check(Array.isArray(created.meshes), "mesh creation returns structured key mappings without a texture");
  const createdMesh = record(created.meshes[0]);
  check(Array.isArray(createdMesh.vertex_keys) && createdMesh.vertex_keys.length === 3, "input vertex order is mapped to keys");
  const before = meshFrom(await project(), probe.name);
  check(JSON.stringify(before.origin) === "[5,7,2]", "mesh position is preserved");
  check(JSON.stringify(before.rotation) === "[0,0,30]", "mesh rotation is preserved");
  check(Object.values(record(before.vertices)).some(vertex => JSON.stringify(vertex) === "[4,0,0]"), "scale is baked into mesh coordinates");
  check(Object.keys(record(before.faces)).length === 1, "indexed triangle is created");
  await call("undo");
  check(record((await json("get_project_info")).counts).meshes === 0, "mesh undo removes all elements");
  await call("redo");
  check(record((await json("get_project_info")).counts).meshes === 1, "mesh redo restores element");
  await call("select_mesh_elements", { mesh_id: probe.name, mode: "vertex" });
  await call("move_mesh_vertices", { mesh_id: probe.name, offset: [0, 1, 0] });
  const moved = meshFrom(await project(), probe.name);
  check(Object.values(record(moved.vertices)).some(vertex => JSON.stringify(vertex) === "[4,1,0]"), "stored vertex selection drives subsequent edits");
  await call("remove_element", { id: probe.name });

  const history = await json("get_undo_stack");
  const invalid = await client.callTool({ name: "place_mesh", arguments: {
    elements: [{ name: "invalid", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 9]] }],
  } });
  check(invalid.isError, "invalid vertex index is rejected");
  check(record((await json("get_project_info")).counts).meshes === 0, "invalid mesh creates no partial elements");
  check(JSON.stringify(await json("get_undo_stack")) === JSON.stringify(history), "invalid mesh leaves undo unchanged");

  const invalidTexture = await client.callTool({ name: "create_texture", arguments: {
    name: "invalid texture", width: 16, height: 16, fill_color: "#ffffff",
  } });
  check(invalidTexture.isError, "texture cross-field refinement is enforced");
  check(record((await json("get_project_info")).counts).textures === 0, "invalid texture leaves no state");
  await call("create_texture", { name: "MCP Porcelain", width: 16, height: 16, fill_color: "#f3f0e9", layer_name: "Base", render_sides: "front" });
  await call("undo");
  check(record((await json("get_project_info")).counts).textures === 0, "texture undo removes created texture");
  await call("redo");
  check(record((await json("get_project_info")).counts).textures === 1, "texture redo restores created texture");

  await call("create_cylinder", { elements: [{ name: "normal probe", position: [0, 0, 0], diameter: 8, height: 2, sides: 8 }], texture: "MCP Porcelain" });
  const cylinder = meshFrom(await project(), "normal probe");
  const positions = record(cylinder.vertices);
  const normalsOut = Object.values(record(cylinder.faces)).every(value => {
    const face = record(value);
    const keys = face.vertices as string[];
    const points = keys.map(key => positions[key] as number[]);
    const [a, b, c] = points;
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const center = [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
    return normal.reduce((sum, value, axis) => sum + value * center[axis], 0) > 0;
  });
  check(normalsOut, "every cylinder face points outward");
  await call("undo");
  check(record((await json("get_project_info")).counts).meshes === 0, "cylinder undo removes created mesh");

  await call("add_group", { name: "MCP Identity Mark", origin: [0, 18, 0] });
  const meshes = createIdentityMeshes();
  await call("place_mesh", { elements: meshes, texture: "MCP Porcelain", group: "MCP Identity Mark" });
  const expected = meshes.map(mesh => [mesh.name, mesh.vertices.length, mesh.faces.length]);
  const model = await project();
  const porcelain = Array.isArray(model.textures) ? model.textures.map(record).find(texture => texture.name === "MCP Porcelain") : undefined;
  check(porcelain, "porcelain texture survives project export");
  check(meshes.every(mesh => {
    const exported = meshFrom(model, mesh.name);
    return Object.keys(record(exported.vertices)).length === mesh.vertices.length
      && Object.keys(record(exported.faces)).length === mesh.faces.length;
  }), "all logo geometry survives project export");
  check(meshes.every(mesh => Object.values(record(meshFrom(model, mesh.name).faces))
    .every(face => record(face).texture === 0)), "every logo face references the supplied texture");
  await call("undo");
  check(record((await json("get_project_info")).counts).meshes === 0, "batch logo undo removes three meshes");
  await call("redo");
  check(record((await json("get_project_info")).counts).meshes === 3, "batch logo redo restores three meshes");
  await call("set_camera_angle", { position: [0, 18, 66], target: [0, 18, 0], projection: "perspective" });
  await saveScreenshot("front.png");
  await call("set_camera_angle", { position: [22, 26, 65], target: [0, 18, 0], projection: "perspective" });
  await saveScreenshot("perspective.png");
  const formats = await json("list_export_formats", { only_current_format: true });
  check(Array.isArray(formats.codecs) && formats.codecs.some(codec => record(codec).id === "project"), "project export codec is discoverable");
  const exported = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  check(!exported.truncated && typeof exported.content === "string", "final bbmodel export is complete");
  await Bun.write(new URL("mcp-identity.bbmodel", output), exported.content);
  await Bun.write(new URL("smoke-results.json", output), JSON.stringify({ endpoint: endpoint.href, checks, tools: tools.tools.length,
    resources: resources.resources.length, prompts: prompts.prompts.length, geometry: expected }, null, 2));
  console.log(`Completed ${checks.length} checks; saved model and previews to ${output.pathname}`);
} finally {
  await client.close();
}
