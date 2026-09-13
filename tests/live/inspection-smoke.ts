import { SHA256_HEX_PATTERN } from "@/build/release-evidence";
import { type LiveSession, runLiveSuite } from "./harness";
import { record, records } from "./narrow";

// Read-only live checks. Keep a mesh project open, or pass an explicit mesh name/UUID.

/** Page size small enough that the inspected mesh spans several vertex and face pages. */
const PAGE_LIMIT = 2;
/** First page size above the tool's documented maximum of 500. */
const OVER_MAX_LIMIT = 501;

/** The inspected mesh identifier and its first, UV-including geometry page. */
interface IInspectedMesh {
  meshId: string;
  info: Record<string, unknown>;
}

/** Calls an inspection tool and requires any structured content to agree with its text payload. */
function inspectJson(session: LiveSession, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return session.json(name, args, { verifyStructured: true });
}

async function snapshot(session: LiveSession): Promise<string> {
  const values = await Promise.all([
    inspectJson(session, "get_project_info"), inspectJson(session, "get_selection"), inspectJson(session, "get_undo_stack"),
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

async function discoveryScenario(session: LiveSession): Promise<void> {
  const discovered = await session.client.listTools();
  ["get_capabilities", "get_mesh_info"].forEach(name => {
    const tool = discovered.tools.find(item => item.name === name);
    session.check(tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false,
      `${name} is discoverable and declared read-only`);
  });
}

async function capabilitiesScenario(session: LiveSession): Promise<void> {
  const capabilities = await inspectJson(session, "get_capabilities", { include_tools: true });
  const plugin = record(capabilities.plugin);
  session.check(typeof record(capabilities.blockbench).version === "string", "capabilities reports Blockbench version");
  session.check(typeof plugin.version === "string", "capabilities reports plugin version");
  session.check(typeof plugin.build_id === "string" && SHA256_HEX_PATTERN.test(plugin.build_id), "capabilities reports compiled source build ID");
  session.check(records(capabilities.formats).some(format => format.id === "free"), "available formats include Generic Model");
  session.check(records(capabilities.tools).some(tool => tool.name === "get_mesh_info" && tool.enabled === true),
    "capabilities reports enabled inspection tool");
  const free = await inspectJson(session, "get_capabilities", { format_id: "free" });
  session.check(record(record(free.format).features).meshes === true, "Generic Model advertises mesh support");
  const java = await inspectJson(session, "get_capabilities", { format_id: "java_block" });
  session.check(record(record(java.format).features).meshes === false, "Java Block does not advertise mesh support");
  session.check(!("tools" in java), "tool listing is omitted by default");
}

async function meshPageScenario(session: LiveSession): Promise<IInspectedMesh> {
  const outline = await inspectJson(session, "list_outline", { include_cubes: false, include_meshes: true });
  const firstMesh = findMesh(records(outline.roots));
  const meshId = Bun.argv[3] ?? firstMesh?.uuid;
  session.check(typeof meshId === "string", "active project contains a mesh to inspect");
  const info = await inspectJson(session, "get_mesh_info", { mesh_id: meshId, limit: PAGE_LIMIT, include_uv: true });
  session.check(info.uuid === meshId || info.name === meshId, "inspection resolves requested mesh");
  const vertexPage = record(info.vertices);
  const facePage = record(info.faces);
  session.check(records(vertexPage.items).length <= PAGE_LIMIT && records(facePage.items).length <= PAGE_LIMIT, "both geometry pages respect the limit");
  session.check(vertexPage.total === record(info.totals).vertices && facePage.total === record(info.totals).faces,
    "page totals describe the full mesh");
  session.check(record(info.bounds).local !== undefined, "bounds explicitly identify local coordinates");
  return { meshId, info };
}

async function vertexPaginationScenario(session: LiveSession, { meshId, info }: IInspectedMesh): Promise<void> {
  const vertexPage = record(info.vertices);
  if (vertexPage.next_offset === null) {
    console.log(`SKIP vertex pagination checks: mesh ${meshId} has at most ${PAGE_LIMIT} vertices, so there is no second page`);
    return;
  }
  const firstVertices = records(vertexPage.items).map(vertex => vertex.key);
  const next = await inspectJson(session, "get_mesh_info", { mesh_id: meshId, vertex_offset: vertexPage.next_offset, limit: PAGE_LIMIT, include_faces: false });
  session.check(records(record(next.vertices).items).every(vertex => !firstVertices.includes(vertex.key)), "vertex pagination has no duplicate keys");
  session.check(!("faces" in next), "face payload can be omitted");
}

async function facePaginationScenario(session: LiveSession, { meshId, info }: IInspectedMesh): Promise<void> {
  const facePage = record(info.faces);
  if (facePage.next_offset === null) {
    console.log(`SKIP face pagination checks: mesh ${meshId} has at most ${PAGE_LIMIT} faces, so there is no second page`);
    return;
  }
  const keys = records(facePage.items).map(face => face.key);
  const next = await inspectJson(session, "get_mesh_info", { mesh_id: meshId, face_offset: facePage.next_offset, limit: PAGE_LIMIT, include_vertices: false });
  session.check(records(record(next.faces).items).every(face => !keys.includes(face.key)), "face pagination has no duplicate keys");
  session.check(!("vertices" in next), "vertex payload can be omitted");
  session.check(records(record(next.faces).items).every(face => !("uv" in face)), "UV payload is omitted by default");
}

async function faceDetailScenario(session: LiveSession, { meshId, info }: IInspectedMesh): Promise<void> {
  records(record(info.faces).items).forEach(face => {
    session.check(Array.isArray(face.normal) && face.normal.length === 3 && face.normal.every(Number.isFinite), `face ${face.key} has finite normal`);
    session.check(typeof face.uv === "object", `face ${face.key} includes requested UV mapping`);
    session.check(typeof record(face.texture).status === "string", `face ${face.key} reports texture state`);
  });
  const summary = await inspectJson(session, "get_mesh_info", { mesh_id: meshId, include_vertices: false, include_faces: false });
  session.check(!("vertices" in summary) && !("faces" in summary), "summary retains metadata without geometry pages");
  const totals = record(info.totals);
  const exhausted = await inspectJson(session, "get_mesh_info", { mesh_id: meshId, vertex_offset: totals.vertices, face_offset: totals.faces });
  session.check(records(record(exhausted.vertices).items).length === 0 && records(record(exhausted.faces).items).length === 0,
    "end offsets return empty pages");
}

async function invalidRequestScenario(session: LiveSession, meshId: string): Promise<void> {
  const invalidCalls = [
    { name: "get_capabilities", arguments: { format_id: "__missing_format__" } },
    { name: "get_mesh_info", arguments: { mesh_id: "__missing_mesh__" } },
    { name: "get_mesh_info", arguments: { mesh_id: meshId, limit: OVER_MAX_LIMIT } },
    { name: "get_mesh_info", arguments: { mesh_id: meshId, vertex_offset: -1 } },
  ];
  const invalidResults = await Promise.all(invalidCalls.map(request => session.client.callTool(request)));
  session.check(invalidResults.every(result => result.isError), "invalid identifiers and pagination are rejected");
}

async function inspectionSuite(session: LiveSession): Promise<void> {
  await discoveryScenario(session);
  const before = await snapshot(session);
  await capabilitiesScenario(session);
  const inspected = await meshPageScenario(session);
  await vertexPaginationScenario(session, inspected);
  await facePaginationScenario(session, inspected);
  await faceDetailScenario(session, inspected);
  await invalidRequestScenario(session, inspected.meshId);
  session.check(await snapshot(session) === before, "inspection preserves project, selection, and undo history");
  await session.writeResults("inspection", checks => ({ endpoint: session.endpoint.href, mesh: inspected.info.uuid, checks }));
  console.log(`Completed ${session.checks.length} read-only live checks.`);
}

await runLiveSuite("blockbench-inspection-smoke", inspectionSuite);
