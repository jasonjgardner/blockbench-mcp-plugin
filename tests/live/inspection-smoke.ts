import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Read-only live checks. Keep a mesh project open, or pass an explicit mesh name/UUID.
const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const client = new Client({ name: "blockbench-inspection-smoke", version: "1.0.0" });
const checks: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function json(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  const text = records(result.content).find(item => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${name} returned no JSON text`);
  const parsed = record(JSON.parse(text));
  if (result.structuredContent) {
    check(JSON.stringify(result.structuredContent) === JSON.stringify(parsed), `${name} structured and text content agree`);
  }
  return parsed;
}

async function snapshot(): Promise<string> {
  const values = await Promise.all([
    json("get_project_info"), json("get_selection"), json("get_undo_stack"),
  ]);
  return JSON.stringify(values);
}

function findMesh(nodes: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return nodes.reduce<Record<string, unknown> | undefined>((found, node) => {
    if (found || node.type === "mesh") return found ?? node;
    if (!Array.isArray(node.children)) return undefined;
    return findMesh(records(node.children));
  }, undefined);
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const discovered = await client.listTools();
  ["get_capabilities", "get_mesh_info"].forEach(name => {
    const tool = discovered.tools.find(item => item.name === name);
    check(tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false,
      `${name} is discoverable and declared read-only`);
  });
  const before = await snapshot();
  const capabilities = await json("get_capabilities", { include_tools: true });
  check(typeof record(capabilities.blockbench).version === "string", "capabilities reports Blockbench version");
  check(typeof record(capabilities.plugin).version === "string", "capabilities reports plugin version");
  check(records(capabilities.formats).some(format => format.id === "free"), "available formats include Generic Model");
  check(records(capabilities.tools).some(tool => tool.name === "get_mesh_info" && tool.enabled === true),
    "capabilities reports enabled inspection tool");
  const free = await json("get_capabilities", { format_id: "free" });
  check(record(record(free.format).features).meshes === true, "Generic Model advertises mesh support");
  const java = await json("get_capabilities", { format_id: "java_block" });
  check(record(record(java.format).features).meshes === false, "Java Block does not advertise mesh support");
  check(!("tools" in java), "tool listing is omitted by default");

  const outline = await json("list_outline", { include_cubes: false, include_meshes: true });
  const firstMesh = findMesh(records(outline.roots));
  const meshId = Bun.argv[3] ?? firstMesh?.uuid;
  check(typeof meshId === "string", "active project contains a mesh to inspect");
  const info = await json("get_mesh_info", { mesh_id: meshId, limit: 2, include_uv: true });
  check(info.uuid === meshId || info.name === meshId, "inspection resolves requested mesh");
  const vertexPage = record(info.vertices);
  const facePage = record(info.faces);
  check(records(vertexPage.items).length <= 2 && records(facePage.items).length <= 2, "both geometry pages respect the limit");
  check(vertexPage.total === record(info.totals).vertices && facePage.total === record(info.totals).faces,
    "page totals describe the full mesh");
  check(record(info.bounds).local !== undefined, "bounds explicitly identify local coordinates");
  const firstVertices = records(vertexPage.items).map(vertex => vertex.key);
  if (vertexPage.next_offset !== null) {
    const next = await json("get_mesh_info", { mesh_id: meshId, vertex_offset: vertexPage.next_offset, limit: 2, include_faces: false });
    check(records(record(next.vertices).items).every(vertex => !firstVertices.includes(vertex.key)), "vertex pagination has no duplicate keys");
    check(!("faces" in next), "face payload can be omitted");
  }
  if (facePage.next_offset !== null) {
    const keys = records(facePage.items).map(face => face.key);
    const next = await json("get_mesh_info", { mesh_id: meshId, face_offset: facePage.next_offset, limit: 2, include_vertices: false });
    check(records(record(next.faces).items).every(face => !keys.includes(face.key)), "face pagination has no duplicate keys");
    check(!("vertices" in next), "vertex payload can be omitted");
    check(records(record(next.faces).items).every(face => !("uv" in face)), "UV payload is omitted by default");
  }
  records(facePage.items).forEach(face => {
    check(Array.isArray(face.normal) && face.normal.length === 3 && face.normal.every(Number.isFinite), `face ${face.key} has finite normal`);
    check(typeof face.uv === "object", `face ${face.key} includes requested UV mapping`);
    check(typeof record(face.texture).status === "string", `face ${face.key} reports texture state`);
  });
  const summary = await json("get_mesh_info", { mesh_id: meshId, include_vertices: false, include_faces: false });
  check(!("vertices" in summary) && !("faces" in summary), "summary retains metadata without geometry pages");
  const exhausted = await json("get_mesh_info", { mesh_id: meshId, vertex_offset: record(info.totals).vertices, face_offset: record(info.totals).faces });
  check(records(record(exhausted.vertices).items).length === 0 && records(record(exhausted.faces).items).length === 0,
    "end offsets return empty pages");
  const invalidCalls = [
    { name: "get_capabilities", arguments: { format_id: "__missing_format__" } },
    { name: "get_mesh_info", arguments: { mesh_id: "__missing_mesh__" } },
    { name: "get_mesh_info", arguments: { mesh_id: meshId, limit: 501 } },
    { name: "get_mesh_info", arguments: { mesh_id: meshId, vertex_offset: -1 } },
  ];
  const invalidResults = await Promise.all(invalidCalls.map(request => client.callTool(request)));
  check(invalidResults.every(result => result.isError), "invalid identifiers and pagination are rejected");
  check(await snapshot() === before, "inspection preserves project, selection, and undo history");
  await Bun.write(new URL("../../artifacts/inspection/smoke-results.json", import.meta.url), JSON.stringify({
    endpoint: endpoint.href, mesh: info.uuid, checks,
  }, null, 2));
  console.log(`Completed ${checks.length} read-only live checks.`);
} finally {
  await client.close();
}
