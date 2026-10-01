import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importGeoModel, parseGeoJson, readGeoJsonSource, selectGeometry, type IBedrockGeometry } from "@/server/tools/import";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Outliner node double; identity is all the undo model needs. */
interface ITestNode {
  readonly name: string;
}

/** Undo aspects `importGeoModel` passes to `Undo.initEdit`. */
interface IImportAspects {
  elements: ITestNode[];
  groups: ITestNode[];
  uv_mode?: boolean;
  display_slots?: string[];
}

interface ISceneSnapshot {
  readonly elements: readonly ITestNode[];
  readonly groups: readonly ITestNode[];
}

interface IFetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

interface IFileRead {
  readonly path: string;
  readonly message?: string;
}

interface IParseCall {
  readonly geometry: unknown;
  readonly args: unknown;
}

const scene: { elements: ITestNode[]; groups: ITestNode[] } = { elements: [], groups: [] };
let fetches: IFetchCall[] = [];
let reads: IFileRead[] = [];
let parses: IParseCall[] = [];
let editAspects: IImportAspects | undefined;
let parseFails = false;

/** Like Blockbench's `loadSave`: nodes the replaced state tracked and the restored state lacks are removed. */
const undo = createUndoHost<ISceneSnapshot, IImportAspects>({
  snapshot: (aspects) => {
    editAspects = aspects;
    return { elements: [...aspects.elements], groups: [...aspects.groups] };
  },
  restore: (target, reference) => {
    scene.elements = scene.elements.filter((node) => !reference.elements.includes(node) || target.elements.includes(node));
    scene.groups = scene.groups.filter((node) => !reference.groups.includes(node) || target.groups.includes(node));
  },
});

/** Like Blockbench's `autoParseJSON(text, false)`: a byte order mark and comments are allowed; invalid input gives undefined. */
function autoParseJSON(text: string): unknown {
  const source = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(source);
  } catch {
    try {
      return JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, ""));
    } catch {
      return undefined;
    }
  }
}

const robot = { description: { identifier: "geometry.robot" }, bones: [{ name: "body" }] };

beforeEach(() => {
  scene.elements = [{ name: "existing" }];
  scene.groups = [];
  fetches = [];
  reads = [];
  parses = [];
  editAspects = undefined;
  parseFails = false;
  undo.reset();
});

useGlobals(() => ({
  Outliner: { get elements() { return scene.elements; } },
  Group: { get all() { return scene.groups; } },
  Undo: undo,
  Codecs: {
    bedrock: {
      parse: () => {
        throw new Error("Codec#parse switches the project to the Bedrock format; importGeoModel must not call it.");
      },
      parseGeometry: (geometry: unknown, args: unknown) => {
        parses.push({ geometry, args });
        scene.groups.push({ name: "body" });
        scene.elements.push({ name: "cube" });
        if (parseFails) throw new Error("bad bone");
      },
    },
  },
  autoParseJSON,
  fetch: async (url: string, init?: RequestInit): Promise<Response> => {
    fetches.push({ url, init });
    return new Response('{"format_version":"1.12.0"}');
  },
  requireNativeModule: (name: string, options?: { message?: string }): unknown => {
    if (name === "url") return { fileURLToPath };
    if (name !== "fs") throw new Error(`Unexpected native module "${name}".`);
    return {
      readFileSync: (path: string): string => {
        reads.push({ path, message: options?.message });
        return "{}";
      },
    };
  },
}));

describe("readGeoJsonSource", () => {
  test("returns inline JSON without reading or fetching", async () => {
    expect(await readGeoJsonSource('\n {"format_version":"1.12.0"}')).toBe('{"format_version":"1.12.0"}');
    expect(fetches).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("refuses URLs on this computer or a private network before fetching", async () => {
    const blocked = [
      "http://localhost:3000/bb-mcp",
      "http://127.0.0.1/model.geo.json",
      "http://2130706433/model.geo.json",
      "https://192.168.0.10/model.geo.json",
      "http://[::1]/model.geo.json",
      "http://[fec0::1]/model.geo.json",
      "http://169.254.169.254/latest/meta-data",
      "http://printer.lan/model.geo.json",
      "http://nas.home.arpa/model.geo.json",
      "http://models.internal/model.geo.json",
    ];
    for (const url of blocked) await expect(readGeoJsonSource(url)).rejects.toThrow("Blocked request to address");
    expect(fetches).toEqual([]);
  });

  test("fetches a public URL without following redirects and aborts with the call", async () => {
    const call = new AbortController();
    expect(await readGeoJsonSource("https://example.com/robot.geo.json", call.signal)).toBe('{"format_version":"1.12.0"}');
    expect(fetches.map((fetched) => [fetched.url, fetched.init?.redirect])).toEqual([["https://example.com/robot.geo.json", "error"]]);
    call.abort();
    expect(fetches[0]?.init?.signal?.aborted).toBe(true);
  });

  test("reads absolute paths and file URLs of local files through Blockbench's file permission", async () => {
    const path = join(tmpdir(), "My Models", "robot.geo.json");
    await readGeoJsonSource(path);
    await readGeoJsonSource(pathToFileURL(path).href);
    await readGeoJsonSource(pathToFileURL(path).href.replace("file:///", "file://localhost/"));
    expect(reads.map((read) => read.path)).toEqual([path, path, path]);
    expect(reads[0]?.message).toBe(`MCP from_geo_json requested read access to load ${path}`);
  });

  test("shows the path in the permission prompt without control or formatting characters", async () => {
    const path = join(tmpdir(), "robot\n.geo\u202E.json");
    await readGeoJsonSource(path);
    expect(reads.map((read) => read.path)).toEqual([path]);
    expect(reads[0]?.message).toBe(`MCP from_geo_json requested read access to load ${join(tmpdir(), "robot.geo.json")}`);
  });

  test("refuses network shares and devices before touching the file system", async () => {
    const refused = [
      "\\\\nas\\share\\robot.geo.json",
      "//nas/share/robot.geo.json",
      "\\\\.\\pipe\\blockbench",
      "\\\\?\\C:\\models\\robot.geo.json",
      "C:\\models\\COM1",
      "C:\\models\\nul.json",
    ];
    for (const input of refused) await expect(readGeoJsonSource(input)).rejects.toThrow("Expected inline GeoJSON");
    await expect(readGeoJsonSource("file://nas/share/robot.geo.json")).rejects.toThrow('not on "nas"');
    expect(reads).toEqual([]);
  });

  test("rejects relative paths and other schemes", async () => {
    for (const input of ["models/robot.geo.json", "ftp://example.com/robot.geo.json", "data:application/json,{}"]) {
      await expect(readGeoJsonSource(input)).rejects.toThrow("Expected inline GeoJSON");
    }
    expect(fetches).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe("parseGeoJson", () => {
  test("accepts a byte order mark and comments, like Blockbench", () => {
    expect(parseGeoJson('\uFEFF{ /* robot */ "format_version": "1.12.0" }')).toEqual({ format_version: "1.12.0" });
  });

  test("reports invalid JSON without quoting the input", () => {
    let message = "";
    try {
      parseGeoJson('{"token": "hunter2",');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Invalid GeoJSON: the input is not valid JSON.");
  });
});

describe("selectGeometry", () => {
  const arm = { description: { identifier: "geometry.arm" } };

  test("takes the only geometry, or the one named with or without the geometry. prefix", () => {
    expect(selectGeometry({ "minecraft:geometry": [robot] })).toEqual({ object: robot, name: "geometry.robot" });
    expect(selectGeometry({ "minecraft:geometry": [robot, arm] }, "geometry.arm").object).toBe(arm);
    expect(selectGeometry({ "minecraft:geometry": [robot, arm] }, "robot").object).toBe(robot);
  });

  test("refuses several geometries without an identifier, an unknown identifier and other files", () => {
    expect(() => selectGeometry({ "minecraft:geometry": [robot, arm] })).toThrow("holds 2 geometries (geometry.robot, geometry.arm)");
    expect(() => selectGeometry({ "minecraft:geometry": [robot] }, "geometry.leg")).toThrow('No geometry "geometry.leg"');
    expect(() => selectGeometry({ "geometry.robot": { bones: [] } })).toThrow('"minecraft:geometry" array');
  });
});

describe("importGeoModel", () => {
  const geometry: IBedrockGeometry = { object: robot, name: "geometry.robot" };

  test("parses into the current project in one undo edit whose undo removes every node it created", () => {
    importGeoModel(geometry);
    expect(parses).toEqual([{ geometry, args: { import_to_current_project: true, switch_to_existing_tab: false } }]);
    expect(undo.history.map((entry) => entry.message)).toEqual(["Agent imported GeoJSON"]);
    expect(editAspects).toMatchObject({ outliner: true, uv_mode: true });
    expect(editAspects).not.toHaveProperty("display_slots");
    expect(scene.elements.map((node) => node.name)).toEqual(["existing", "cube"]);
    expect(scene.groups.map((node) => node.name)).toEqual(["body"]);

    undo.undo();
    expect(scene.elements.map((node) => node.name)).toEqual(["existing"]);
    expect(scene.groups).toEqual([]);
  });

  test("includes the display slots a geometry sets in the undo edit", () => {
    importGeoModel({ object: { ...robot, item_display_transforms: { gui: {}, head: {} } }, name: "geometry.robot" });
    expect(editAspects?.display_slots).toEqual(["gui", "head"]);
  });

  test("a failed parse is reverted without a history entry", () => {
    parseFails = true;
    expect(() => importGeoModel(geometry)).toThrow("bad bone");
    expect(scene.elements.map((node) => node.name)).toEqual(["existing"]);
    expect(scene.groups).toEqual([]);
    expect(undo.history).toEqual([]);
  });
});
