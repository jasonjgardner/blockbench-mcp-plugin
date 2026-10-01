/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { captureAppScreenshot } from "@/lib/util";
import { STATUS_STABLE } from "@/lib/constants";
import { isAbsoluteLocalPath, readLocalTextFile, toLocalPath } from "@/lib/local-files";
import { runUndoableEdit } from "@/lib/undo";
import { isLocalNetworkHostname } from "@/server/net-security";

export const fromGeoJsonParameters = z.object({
  geojson: z
    .string()
    .describe(
      "Bedrock geometry (format 1.12 or later) as inline JSON, an absolute path or file:// URL of a file on this computer (read with Blockbench's file permission), or a public http(s) URL (at most 10 MB)."
    ),
  geometry: z
    .string()
    .optional()
    .describe("Identifier of the geometry to import, such as geometry.robot, when the file holds several. Omit it when the file holds one."),
});

export const importToolDocs: IToolSpec[] = [
  {
    name: "from_geo_json",
    condition: { project: true, features: ["bone_rig"], method: () => !Blockbench.isWeb && bedrockCodec() !== undefined },
    description: "Imports one Bedrock geometry (.geo.json) into the current project, which keeps its format (one with bones: Bedrock, GeckoLib, generic, ...), as one undoable edit, and returns a screenshot. Adds the bones with their cubes, locators and texture meshes; the texture size, box UV mode and item display transforms it sets are undone with it, while the project's visible bounds can only grow. URLs on this computer or a private network are refused; pass a file path instead.",
    annotations: {
      title: "Import GeoJSON",
      destructiveHint: true,
    },
    parameters: fromGeoJsonParameters,
    status: STATUS_STABLE,
  },
];

/** Longest wait for a remote geometry file. */
const FETCH_TIMEOUT_MS = 30_000;

/** Largest remote geometry file read; a model file is usually well under a megabyte. */
export const MAX_GEOJSON_BYTES = 10 * 1024 * 1024;

/**
 * Reads a response body as UTF-8 text without buffering more than `limit` bytes. A declared
 * `Content-Length` above the limit is refused before reading; without one (or with a wrong one),
 * the read stops and the stream is cancelled as soon as the limit is passed.
 *
 * @param label - What is being read, for the error message.
 * @throws {Error} When the body is larger than `limit`.
 */
export async function readLimitedText(res: Response, limit: number, label: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${label} is ${declared} bytes, more than the ${limit}-byte limit.`);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} is more than the ${limit}-byte limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** One geometry of a Bedrock geometry file, in the shape the codec's `parseGeometry` takes. */
export interface IBedrockGeometry {
  object: Record<string, unknown>;
  /** `description.identifier`, such as `geometry.robot`; empty when missing. */
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Bedrock codec when it exposes `parseGeometry` (Blockbench does; blockbench-types does not declare it). */
function bedrockCodec(): object | undefined {
  const codec: unknown = Reflect.get(Codecs, "bedrock");
  if (typeof codec !== "object" || codec === null) return undefined;
  return typeof Reflect.get(codec, "parseGeometry") === "function" ? codec : undefined;
}

/**
 * Fetches geometry from a public URL. Loopback and private-network hosts are
 * refused, and so are redirects, which could lead a public URL to such a host.
 */
async function fetchGeoJson(url: URL, signal?: AbortSignal): Promise<string> {
  if (isLocalNetworkHostname(url.hostname)) {
    throw new Error(`Blocked request to address "${url.hostname}": only public URLs are fetched. Pass a local file path instead.`);
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.href, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch GeoJSON from "${url.href}" (${reason}). Redirects are not followed; pass the final URL.`, { cause: error });
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch GeoJSON from "${url.href}": ${res.status} ${res.statusText}`);
  }
  return readLimitedText(res, MAX_GEOJSON_BYTES, `GeoJSON from "${url.href}"`);
}

/**
 * Loads the geometry text: inline JSON as given, a public http(s) URL through
 * {@link fetchGeoJson}, or an absolute path or `file://` URL of a local file
 * through Blockbench's permission-checked file system.
 *
 * @throws {Error} For any other input, network or device paths, blocked addresses, failed fetches or reads.
 */
export async function readGeoJsonSource(geojson: string, signal?: AbortSignal): Promise<string> {
  const source = geojson.trim();
  if (source.startsWith("{") || source.startsWith("[")) return source;
  if (/^https?:\/\//i.test(source)) return fetchGeoJson(new URL(source), signal);
  const path = toLocalPath(source);
  if (!isAbsoluteLocalPath(path)) {
    throw new Error(
      `Expected inline GeoJSON, an absolute path or file:// URL of a file on this computer, or an http(s) URL; got "${source.slice(0, 80)}".`
    );
  }
  return readLocalTextFile(path, "from_geo_json");
}

/**
 * Parses geometry text like Blockbench does (byte order mark and comments
 * allowed). The error is generic on purpose: the engine's syntax error quotes
 * part of the input, which may be any file the client named.
 */
export function parseGeoJson(text: string): unknown {
  const parsed: unknown = autoParseJSON(text, false);
  if (parsed === undefined) throw new Error("Invalid GeoJSON: the input is not valid JSON.");
  return parsed;
}

/**
 * Picks the geometry to import: the one whose identifier is `identifier` (with
 * or without the `geometry.` prefix), or the only one in the file.
 *
 * @throws {Error} For files without a `minecraft:geometry` array, an unknown
 *   identifier, or several geometries and no identifier.
 */
export function selectGeometry(model: unknown, identifier?: string): IBedrockGeometry {
  const list: unknown = isRecord(model) ? model["minecraft:geometry"] : undefined;
  const geometries: IBedrockGeometry[] = (Array.isArray(list) ? list : []).filter(isRecord).map(object => {
    const description: unknown = object.description;
    const name: unknown = isRecord(description) ? description.identifier : undefined;
    return { object, name: typeof name === "string" ? name : "" };
  });
  if (!geometries.length) {
    throw new Error('Expected Bedrock geometry 1.12 or later: an object with a "minecraft:geometry" array of geometries.');
  }
  const names = geometries.map(geometry => geometry.name || "(unnamed)").join(", ");
  if (identifier !== undefined) {
    const wanted = identifier.replace(/^geometry\./, "");
    const match = geometries.find(geometry => geometry.name.replace(/^geometry\./, "") === wanted);
    if (!match) throw new Error(`No geometry "${identifier}" in the file; it holds ${names}.`);
    return match;
  }
  if (geometries.length > 1) {
    throw new Error(`The file holds ${geometries.length} geometries (${names}); pass geometry with the identifier of the one to import.`);
  }
  return geometries[0];
}

/**
 * Imports one geometry into the current project in one undo edit. The codec's
 * `parseGeometry` is called directly: its `parse` would switch a non-Bedrock
 * project to the Bedrock format, even when parsing fails, and for several
 * geometries open a dialog that imports later, outside the edit. The nodes it
 * creates join the edit also when parsing fails, so Undo (or the revert of a
 * failed import) removes them; `uv_mode` and `display_slots` cover the texture
 * size, box UV mode and item display transforms it sets.
 */
export function importGeoModel(geometry: IBedrockGeometry): void {
  const codec = bedrockCodec();
  const parse: unknown = codec ? Reflect.get(codec, "parseGeometry") : undefined;
  if (!codec || typeof parse !== "function") throw new Error("This Blockbench version does not expose the Bedrock geometry parser.");
  const transforms = geometry.object.item_display_transforms;
  const elements: OutlinerElement[] = [];
  const groups: Group[] = [];
  const aspects = {
    elements,
    groups,
    outliner: true,
    uv_mode: true,
    ...(isRecord(transforms) ? { display_slots: Object.keys(transforms) } : {}),
  };
  runUndoableEdit(aspects, "Agent imported GeoJSON", () => {
    const known = new Set<OutlinerNode>([...Outliner.elements, ...Group.all]);
    try {
      // import_to_current_project keeps the project's identifier and texture size;
      // switch_to_existing_tab: false keeps Blockbench from closing this project
      // when another tab holds a geometry of the same name.
      Reflect.apply(parse, codec, [geometry, { import_to_current_project: true, switch_to_existing_tab: false }]);
    } finally {
      elements.push(...Outliner.elements.filter((element) => !known.has(element)));
      groups.push(...Group.all.filter((group) => !known.has(group)));
    }
  });
}

export function registerImportTools() {
  createTool(importToolDocs[0].name, {
    ...importToolDocs[0],
    async execute({ geojson, geometry }, context) {
      const model = parseGeoJson(await readGeoJsonSource(geojson, context?.signal));
      importGeoModel(selectGeometry(model, geometry));

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          captureAppScreenshot().then(resolve).catch(reject);
        }, 3000);
      });
    },
  }, importToolDocs[0].status);
}
