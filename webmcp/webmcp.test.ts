/// <reference types="blockbench-types" />
/// <reference types="webmcp-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { adaptMcpToolToWebMcp } from "@/webmcp/adapter";
import evalsJson from "@/webmcp/evals.json";
import {
  clampWebMcpPayload,
  paginateWebMcpItems,
  registerWebMcpToolset,
  sanitizeWebMcpAnnotations,
  validateToolAgainstWebMcpChecklist,
  WEBMCP_MAX_OUTPUT_CHARS,
} from "@/webmcp/runtime";
import schemaJson from "@/webmcp/schema.json";
import { createBlockbenchWebMcpTools } from "@/webmcp/tools";

interface ICapturedRegistration {
  tool: WebMCP.ModelContextTool;
  options?: WebMCP.ModelContextRegisterToolOptions;
}

function createMockDocumentWithModelContext(): {
  doc: Document;
  captured: Map<string, ICapturedRegistration>;
} {
  const captured = new Map<string, ICapturedRegistration>();
  const modelContext = {
    async registerTool(
      tool: WebMCP.ModelContextTool,
      options?: WebMCP.ModelContextRegisterToolOptions,
    ): Promise<void> {
      captured.set(tool.name, { tool, options });
      options?.signal?.addEventListener("abort", () => {
        captured.delete(tool.name);
      });
    },
    async getTools(): Promise<WebMCP.RegisteredTool[]> {
      return [...captured.values()].map(({ tool }) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        window: globalThis as unknown as Window,
        origin: "https://web.blockbench.net",
        annotations: tool.annotations,
      }));
    },
    async executeTool(): Promise<string> {
      return "";
    },
    ontoolchange: null,
    ontoolactivated: null,
    ontoolcancel: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return true;
    },
  } satisfies WebMCP.ModelContext;

  const doc = { modelContext } as unknown as Document;
  return { doc, captured };
}

describe("WebMCP Tool Checklist & Schema Compliance", () => {
  const tools = createBlockbenchWebMcpTools();

  test("all 10 consolidated WebMCP tools pass the audit checklist with zero findings", () => {
    expect(tools.length).toBe(10);
    expect(schemaJson.tools.length).toBe(10);

    tools.forEach(tool => {
      const findings = validateToolAgainstWebMcpChecklist(tool);
      expect(findings).toEqual([]);
    });
  });

  test("annotations follow the navigation, consequential, and untrusted-content rules", () => {
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    // create_project opens a new tab without discarding work, so it is a routine mutation.
    expect(byName.get("create_project")?.annotations).toBeUndefined();
    // switch_editor_mode is UI navigation: no readOnlyHint, no consequentialHint.
    expect(byName.get("switch_editor_mode")?.annotations).toBeUndefined();
    // Compiled model text carries user-authored names, so the agent must treat it as untrusted.
    expect(byName.get("export_project_model")?.annotations).toEqual({ untrustedContentHint: true });
    expect(byName.get("list_outliner_items")?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(byName.has("manage_textures")).toBe(true);
    expect(byName.has("edit_texture_and_uv")).toBe(false);
  });

  test("the checklist validator audits nested array-item parameter descriptions", () => {
    const findings = validateToolAgainstWebMcpChecklist({
      name: "demo_tool",
      description: "Does a thing. Use when demonstrating validation.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Batch entries",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "x".repeat(151) },
                blank: { type: "string", description: "" },
              },
            },
          },
        },
      },
      execute: async () => ({}),
    });
    expect(findings.map(finding => finding.message)).toEqual([
      expect.stringContaining('Parameter "items[].label" description (151 chars)'),
      expect.stringContaining('Parameter "items[].blank" has no description'),
    ]);
  });

  test("annotations are strictly opt-in and never declare false", () => {
    expect(sanitizeWebMcpAnnotations({ readOnlyHint: false, consequentialHint: false })).toBeUndefined();
    expect(sanitizeWebMcpAnnotations({ readOnlyHint: true, consequentialHint: false })).toEqual({
      readOnlyHint: true,
    });
    expect(sanitizeWebMcpAnnotations({ readOnlyHint: true, consequentialHint: true })).toEqual({
      consequentialHint: true,
    });
  });

  test("evals.json trajectories reference valid tools and follow Stage 5 syntax", () => {
    const validToolNames = new Set(schemaJson.tools.map(t => t.name));
    expect(Array.isArray(evalsJson)).toBe(true);
    expect(evalsJson.length).toBeGreaterThanOrEqual(5);

    evalsJson.forEach(testCase => {
      expect(typeof testCase.name).toBe("string");
      expect(Array.isArray(testCase.messages)).toBe(true);
      expect(Array.isArray(testCase.expectedCall)).toBe(true);
      testCase.expectedCall.forEach(step => {
        if ("functionName" in step && typeof step.functionName === "string") {
          expect(validToolNames.has(step.functionName)).toBe(true);
        }
      });
    });
  });

  test("pagination and payload budget clamping stay within 1,500 characters", () => {
    const items = Array.from({ length: 30 }, (_, idx) => ({
      id: `cube-${idx + 1}`,
      name: `Cube_${idx + 1}`,
    }));
    const page1 = paginateWebMcpItems(items, 1, 12, { types: { cube: 30 } });
    expect(page1.page).toBe(1);
    expect(page1.page_size).toBe(12);
    expect(page1.total_count).toBe(30);
    expect(page1.total_pages).toBe(3);
    expect(page1.results.length).toBe(12);

    const oversized = "x".repeat(3200);
    const clamped = clampWebMcpPayload(oversized);
    expect(JSON.stringify(clamped).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);
    expect((clamped as { truncated: boolean }).truncated).toBe(true);

    // Quote-heavy text escapes to more characters than its raw length; the envelope must still fit.
    const quoteHeavy = JSON.stringify({ rows: Array.from({ length: 120 }, (_, i) => ({ k: `"v${i}"`, n: "\n" })) });
    const clampedQuotes = clampWebMcpPayload(quoteHeavy) as { truncated: boolean; content: string; next_offset: number };
    expect(JSON.stringify(clampedQuotes).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);
    expect(clampedQuotes.truncated).toBe(true);
    expect(quoteHeavy.startsWith(clampedQuotes.content)).toBe(true);
    expect(clampedQuotes.next_offset).toBe(clampedQuotes.content.length);
  });

  test("oversized pagination envelopes shrink and tell the agent how to re-page without gaps", () => {
    const wide = Array.from({ length: 12 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-${String(idx).padStart(12, "0")}`,
      name: `a_rather_long_outliner_element_name_${idx}`,
      type: "cube",
      parent: "a_rather_long_parent_group_name",
      selected: false,
      extra: "x".repeat(60),
    }));
    const envelope = paginateWebMcpItems(wide, 1, 12);
    expect(JSON.stringify(envelope).length).toBeGreaterThan(WEBMCP_MAX_OUTPUT_CHARS);

    const clamped = clampWebMcpPayload(envelope) as {
      truncated: boolean;
      page_size: number;
      results: unknown[];
      continuation_hint: string;
      total_count: number;
    };
    expect(JSON.stringify(clamped).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);
    expect(clamped.truncated).toBe(true);
    expect(clamped.results.length).toBe(clamped.page_size);
    expect(clamped.results.length).toBeGreaterThan(1);
    expect(clamped.total_count).toBe(12);
    expect(clamped.continuation_hint).toContain(`page_size=${clamped.page_size}`);
  });

  test("the default outliner page fits the output budget without clamping", () => {
    const rows = Array.from({ length: 10 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-${String(idx).padStart(12, "0")}`,
      name: `right_leg_lower_segment_${idx}`,
      type: "cube",
      parent: "right_leg_upper_group",
      ...(idx === 0 ? { selected: true } : {}),
    }));
    const envelope = paginateWebMcpItems(rows, 1, undefined, { types: { cube: 10, mesh: 0, group: 1 } });
    expect(envelope.page_size).toBe(10);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);
    expect(clampWebMcpPayload(envelope)).toBe(envelope);
  });
});

describe("Blockbench WebMCP Imperative Lifecycle & Execution", () => {
  const savedGlobals: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of ["Project", "Format", "Formats", "Modes", "Outliner", "Group", "Cube", "Mesh", "Texture", "Undo", "Canvas", "Codecs", "newProject"]) {
      savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
    }

    class MockGroup {
      public static all: MockGroup[] = [];
      public uuid: string;
      public name: string;
      public origin: [number, number, number];
      public rotation: [number, number, number];
      public parent: MockGroup | "root" = "root";
      public children: unknown[] = [];
      public selected = false;

      public constructor(opts: { name?: string; origin?: [number, number, number]; rotation?: [number, number, number] } = {}) {
        this.uuid = `grp-${MockGroup.all.length + 1}`;
        this.name = opts.name ?? "bone";
        this.origin = opts.origin ?? [0, 0, 0];
        this.rotation = opts.rotation ?? [0, 0, 0];
      }

      public init(): this {
        MockGroup.all.push(this);
        return this;
      }

      public addTo(parent: MockGroup | "root"): this {
        this.parent = parent;
        return this;
      }

      public createUniqueName(): void {}

      public isChildOf(target: MockGroup): boolean {
        return this.parent === target;
      }

      public remove(): void {
        MockGroup.all = MockGroup.all.filter(g => g !== this);
      }
    }

    class MockCube {
      public static all: MockCube[] = [];
      public uuid: string;
      public name: string;
      public type = "cube";
      public from: [number, number, number];
      public to: [number, number, number];
      public origin: [number, number, number];
      public rotation: [number, number, number];
      public parent: MockGroup | "root" = "root";

      public constructor(opts: {
        name: string;
        from: [number, number, number];
        to: [number, number, number];
        origin?: [number, number, number];
        rotation?: [number, number, number];
      }) {
        this.uuid = `cube-${MockCube.all.length + 1}`;
        this.name = opts.name;
        this.from = opts.from;
        this.to = opts.to;
        this.origin = opts.origin ?? [0, 0, 0];
        this.rotation = opts.rotation ?? [0, 0, 0];
      }

      public init(): this {
        MockCube.all.push(this);
        (globalThis as unknown as { Outliner: { elements: unknown[] } }).Outliner.elements.push(this);
        return this;
      }

      public addTo(parent: MockGroup | "root"): this {
        this.parent = parent;
        return this;
      }

      public applyTexture(): void {}

      public isChildOf(target: MockGroup): boolean {
        return this.parent === target;
      }

      public remove(): void {
        MockCube.all = MockCube.all.filter(c => c !== this);
      }
    }

    Object.assign(globalThis, {
      Project: {
        name: "TestKnight",
        uuid: "proj-1",
        saved: true,
        texture_width: 32,
        texture_height: 32,
      },
      Format: {
        id: "bedrock",
        name: "Bedrock Entity",
        bone_rig: true,
        meshes: true,
        animation_mode: true,
        codec: { id: "bedrock" },
      },
      Formats: {
        bedrock: { id: "bedrock" },
        java_block: { id: "java_block" },
      },
      Modes: {
        selected: { id: "edit" },
        options: {
          edit: {
            id: "edit",
            select(): void {
              (globalThis as unknown as { Modes: { selected: { id: string } } }).Modes.selected = { id: "edit" };
            },
          },
          paint: {
            id: "paint",
            select(): void {
              (globalThis as unknown as { Modes: { selected: { id: string } } }).Modes.selected = { id: "paint" };
            },
          },
          animate: {
            id: "animate",
            select(): void {
              (globalThis as unknown as { Modes: { selected: { id: string } } }).Modes.selected = { id: "animate" };
            },
          },
        },
      },
      Group: MockGroup,
      Cube: MockCube,
      Mesh: { all: [] },
      Texture: { all: [], selected: null, getDefault: () => null },
      Outliner: { root: [], elements: [], selected: [] },
      Undo: {
        index: 0,
        history: [] as Array<{ action: string }>,
        initEdit(): void {},
        finishEdit(label: string): void {
          this.history.push({ action: label });
          this.index = this.history.length;
        },
        cancelEdit(): void {},
        undo(): void {
          if (this.index > 0) this.index--;
        },
        redo(): void {
          if (this.index < this.history.length) this.index++;
        },
      },
      Canvas: {
        updateAll(): void {},
        updateAllFaces(): void {},
      },
      Codecs: {
        bedrock: {
          id: "bedrock",
          name: "Bedrock Model",
          extension: "geo.json",
          compile: () => JSON.stringify({
            format_version: "1.12.0",
            "minecraft:geometry": Array.from({ length: 40 }, (_, i) => ({ name: `bone_${i}`, pivot: [0, i, 0], cubes: [{ origin: [-1, i, -1], size: [2, 2, 2] }] })),
          }),
          export: async () => {},
        },
        dense: {
          id: "dense",
          name: "Quote Dense",
          extension: "json",
          // Every character escapes to two or more when serialized, so a 1000-char slice cannot fit as-is.
          compile: () => JSON.stringify(Array.from({ length: 200 }, (_, i) => JSON.stringify(`"q${i}"\n`))),
        },
      },
      newProject(format: { id: string }): boolean {
        (globalThis as unknown as { Project: unknown }).Project = {
          name: "",
          uuid: `proj-${format.id}`,
          saved: true,
          texture_width: 16,
          texture_height: 16,
        };
        return true;
      },
    });
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedGlobals)) {
      if (val === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      }
      if (val !== undefined) {
        (globalThis as Record<string, unknown>)[key] = val;
      }
    }
  });

  test("registers tools on document.modelContext, executes modeling batch + export, and unregisters via AbortSignal", async () => {
    const { doc, captured } = createMockDocumentWithModelContext();
    const tools = createBlockbenchWebMcpTools();
    const handle = await registerWebMcpToolset(tools, { targetDocument: doc });

    expect(captured.size).toBe(10);
    expect(handle.getRegisteredToolNames().length).toBe(10);

    const summaryTool = captured.get("get_project_summary")?.tool;
    expect(summaryTool).toBeDefined();
    const summaryResult = (await summaryTool!.execute(
      { include_formats: true },
      { signal: new AbortController().signal },
    )) as { status: string; project: { name: string } };
    expect(summaryResult.status).toBe("open");
    expect(summaryResult.project.name).toBe("TestKnight");

    const mutateTool = captured.get("mutate_outliner_items")?.tool;
    const createGroupRes = (await mutateTool!.execute(
      { operation: "create_group", group_name: "body" },
      { signal: new AbortController().signal },
    )) as { status: string; name: string };
    expect(createGroupRes.status).toBe("created_group");
    expect(createGroupRes.name).toBe("body");

    const createCubeRes = (await mutateTool!.execute(
      {
        operation: "create_cubes",
        parent_group: "body",
        cubes: [{ name: "torso", from: [-4, 12, -2], to: [4, 24, 2] }],
      },
      { signal: new AbortController().signal },
    )) as { status: string; count: number };
    expect(createCubeRes.status).toBe("created_cubes");
    expect(createCubeRes.count).toBe(1);

    const animTool = captured.get("manage_animations")?.tool;
    const wrongModeError = (await animTool!.execute(
      { operation: "create", animation_name: "walk" },
      { signal: new AbortController().signal },
    )) as { error: string; code: string; retryable: boolean };
    expect(wrongModeError.code).toBe("PREREQUISITE_MODE");
    expect(wrongModeError.retryable).toBe(true);

    const exportTool = captured.get("export_project_model")?.tool;
    const downloadHandOff = (await exportTool!.execute(
      { action: "initiate_download", codec_id: "bedrock" },
      { signal: new AbortController().signal },
    )) as { status: string; codec_id: string };
    expect(downloadHandOff.status).toBe("requires_user_action");
    expect(downloadHandOff.codec_id).toBe("bedrock");

    const preview = (await exportTool!.execute(
      { action: "compile_preview", codec_id: "bedrock", limit: 1000 },
      { signal: new AbortController().signal },
    )) as { status: string; truncated: boolean; returned_length: number; next_offset: number; content: string; total_length: number };
    expect(preview.status).toBe("compiled");
    expect(preview.truncated).toBe(true);
    expect(preview.returned_length).toBe(1000);
    expect(preview.next_offset).toBe(1000);
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);

    // Quote-dense output escapes to more than the raw slice; the slice must shrink to stay in budget.
    const dense = (await exportTool!.execute(
      { action: "compile_preview", codec_id: "dense", limit: 1000, offset: 10 },
      { signal: new AbortController().signal },
    )) as { truncated: boolean; returned_length: number; next_offset: number; offset: number };
    expect(dense.truncated).toBe(true);
    expect(dense.offset).toBe(10);
    expect(dense.returned_length).toBeLessThan(1000);
    expect(dense.next_offset).toBe(10 + dense.returned_length);
    expect(JSON.stringify(dense).length).toBeLessThanOrEqual(WEBMCP_MAX_OUTPUT_CHARS);

    const listTool = captured.get("list_outliner_items")?.tool;
    const listing = (await listTool!.execute(
      { types: ["cube"] },
      { signal: new AbortController().signal },
    )) as { total_count: number; results: Array<Record<string, unknown>> };
    expect(listing.total_count).toBe(1);
    expect(listing.results[0]).toEqual({ id: "cube-1", name: "torso", type: "cube", parent: "body" });

    handle.dispose();
    expect(captured.size).toBe(0);
  });

  test("create_project opens a new tab even while the current project has unsaved changes", async () => {
    (globalThis as unknown as { Project: { saved: boolean } }).Project.saved = false;
    const { doc, captured } = createMockDocumentWithModelContext();
    const handle = await registerWebMcpToolset(createBlockbenchWebMcpTools(), { targetDocument: doc });
    const result = (await captured.get("create_project")!.tool.execute(
      { project_name: "Lantern", format_id: "java_block" },
      { signal: new AbortController().signal },
    )) as { status: string; project_name: string; previous_project_still_open?: string };
    expect(result.status).toBe("created");
    expect(result.project_name).toBe("Lantern");
    expect(result.previous_project_still_open).toBe("TestKnight");

    const unknownFormat = (await captured.get("create_project")!.tool.execute(
      { project_name: "Bad", format_id: "toString" },
      { signal: new AbortController().signal },
    )) as { code: string; retryable: boolean };
    expect(unknownFormat.code).toBe("INVALID_FORMAT");
    expect(unknownFormat.retryable).toBe(true);
    handle.dispose();
  });

  test("a rejected registerTool call is recorded, does not block other tools, and is retried on refresh", async () => {
    const { doc, captured } = createMockDocumentWithModelContext();
    const original = doc.modelContext!.registerTool.bind(doc.modelContext);
    let rejectOnce = true;
    (doc.modelContext as { registerTool: unknown }).registerTool = async (
      tool: WebMCP.ModelContextTool,
      options?: WebMCP.ModelContextRegisterToolOptions,
    ): Promise<void> => {
      if (tool.name === "manage_history" && rejectOnce) {
        rejectOnce = false;
        throw new TypeError("Invalid schema for manage_history");
      }
      return original(tool, options);
    };

    const handle = await registerWebMcpToolset(createBlockbenchWebMcpTools(), { targetDocument: doc });
    expect(captured.size).toBe(9);
    expect(handle.getRegisteredToolNames()).not.toContain("manage_history");
    expect(handle.getRegistrationFailures().get("manage_history")).toBe("Invalid schema for manage_history");

    await handle.refreshAvailability();
    expect(captured.size).toBe(10);
    expect(handle.getRegistrationFailures().size).toBe(0);
    handle.dispose();
  });

  test("adaptMcpToolToWebMcp bridges existing IToolSpec + Zod schemas into WebMCP tools", async () => {
    const adapted = adaptMcpToolToWebMcp({
      name: "legacy_cube_inspector",
      description: "Inspects `cube_id` bounds in the current model.",
      annotations: {
        title: "Legacy Cube Inspector",
        readOnlyHint: true,
        destructiveHint: false,
      },
      parameters: z.object({
        cube_id: z.string().describe("Target cube identifier."),
      }),
      status: "stable",
      async execute({ cube_id }) {
        return JSON.stringify({ inspected: cube_id, valid: true });
      },
    });

    const findings = validateToolAgainstWebMcpChecklist(adapted);
    expect(findings).toEqual([]);
    expect(adapted.annotations).toEqual({ readOnlyHint: true });

    const { doc, captured } = createMockDocumentWithModelContext();
    const handle = await registerWebMcpToolset([adapted], { targetDocument: doc });
    const registered = captured.get("legacy_cube_inspector")?.tool;
    expect(registered).toBeDefined();

    const output = await registered!.execute(
      { cube_id: "cube-1" },
      { signal: new AbortController().signal },
    );
    expect(output).toEqual({ inspected: "cube-1", valid: true });

    const invalid = (await registered!.execute(
      { cube_id: 42 },
      { signal: new AbortController().signal },
    )) as { code: string; retryable: boolean; error: string };
    expect(invalid.code).toBe("INVALID_ARGUMENTS");
    expect(invalid.retryable).toBe(true);
    expect(invalid.error).toContain("cube_id");
    handle.dispose();
  });

  test("adaptMcpToolToWebMcp keeps nested item schemas and surfaces MCP isError results as errors", async () => {
    const adapted = adaptMcpToolToWebMcp({
      name: "legacy_batch_mover",
      description: "Moves `elements` by an offset. Use when nudging several cubes at once.",
      annotations: { title: "Batch Mover", destructiveHint: true },
      parameters: z.object({
        elements: z.array(z.object({
          id: z.string().describe("Element UUID"),
          offset: z.array(z.number()).length(3).describe("Translation [x, y, z]"),
        })).min(1).describe("Elements to move"),
        mode: z.enum(["relative", "absolute"]).optional().describe("How the offset is applied"),
        note: z.string().nullable().optional().describe("Optional label"),
      }),
      status: "stable",
      async execute() {
        return { content: [{ type: "text", text: "Element not found: cube-9" }], isError: true };
      },
    });

    // destructiveHint is not consequential: Blockbench edits are undoable.
    expect(adapted.annotations).toBeUndefined();
    expect(adapted.description).toBe("Moves elements by an offset. Use when nudging several cubes at once.");
    expect(adapted.inputSchema.required).toEqual(["elements"]);
    expect(adapted.inputSchema.properties.elements).toEqual({
      type: "array",
      description: "Elements to move",
      minItems: 1,
      items: {
        type: "object",
        description: "Parameter elements item",
        properties: {
          id: { type: "string", description: "Element UUID" },
          offset: { type: "array", description: "Translation [x, y, z]", minItems: 3, maxItems: 3, items: { type: "number", description: "Parameter offset item" } },
        },
        required: ["id", "offset"],
      },
    });
    expect(adapted.inputSchema.properties.mode).toEqual({ type: "string", description: "How the offset is applied", enum: ["relative", "absolute"] });
    expect(adapted.inputSchema.properties.note).toEqual({ type: "string", description: "Optional label" });
    expect(validateToolAgainstWebMcpChecklist(adapted)).toEqual([]);

    const { doc, captured } = createMockDocumentWithModelContext();
    const handle = await registerWebMcpToolset([adapted], { targetDocument: doc });
    const failure = (await captured.get("legacy_batch_mover")!.tool.execute(
      { elements: [{ id: "cube-9", offset: [1, 0, 0] }] },
      { signal: new AbortController().signal },
    )) as { error: string; code: string; retryable: boolean };
    expect(failure.code).toBe("TOOL_ERROR");
    expect(failure.error).toBe("Element not found: cube-9");
    handle.dispose();
  });
});
