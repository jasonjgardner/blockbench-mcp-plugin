import { describe, expect, test } from "bun:test";
import { SCRATCHPAD_MODE_ID, SETTING_SCRATCHPAD_ENABLED } from "@/lib/constants";
import { aliasEditMode, collectModeArrays, removeEditAlias } from "@/lib/scratchpad-aliases";
import {
  RELAXED_GUARDRAILS,
  onScratchpadSettingChanged,
  relaxGuardrails,
  scratchpadCondition,
  setupScratchpadMode,
  snapshotGuardrails,
  teardownScratchpadMode,
  type IGuardrailFlags,
} from "@/lib/scratchpad-mode";
import { useGlobals } from "@/tests/helpers/globals";

/** Bedrock-like format double carrying every guardrail Blockbench enforces on cubes. */
function bedrockFormat(): IGuardrailFlags & { id: string; edit_mode: boolean } {
  return {
    id: "bedrock",
    edit_mode: true,
    rotation_limit: true,
    rotation_snap: true,
    integer_size: true,
    cube_size_limiter: { test: () => true },
  };
}

interface IModeOptions {
  name?: string;
  condition?: () => boolean;
  onSelect?: () => void;
  onUnselect?: () => void;
}

/** Records constructor calls and deletions the way Blockbench's `Mode` registry would. */
class HostMode {
  static registered: HostMode[] = [];
  static deleted: string[] = [];
  readonly id: string;
  readonly options: IModeOptions;

  constructor(id: string, options: IModeOptions) {
    this.id = id;
    this.options = options;
    HostMode.registered.push(this);
  }

  delete(): void {
    HostMode.deleted.push(this.id);
  }
}

/** Parent class whose cleanup `Mode.delete()` skips in the host. */
class HostKeybindItem {
  static deleted: unknown[] = [];

  delete(): void {
    HostKeybindItem.deleted.push(this);
  }
}

type Listener = () => void;
const listeners = new Map<string, Listener[]>();
const settingValues: Record<string, unknown> = {};
const triggered: string[] = [];
let gridBuilds = 0;
let moveTool: { modes: string[]; condition: { modes: string[] } };
let outlinerPanel: { condition: { modes: string[] } };
let projects: { uuid: string; mode?: string }[];

function dispatch(event: string): void {
  (listeners.get(event) ?? []).forEach(listener => listener());
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

useGlobals(() => {
  HostMode.registered = [];
  HostMode.deleted = [];
  HostKeybindItem.deleted = [];
  listeners.clear();
  triggered.length = 0;
  gridBuilds = 0;
  Object.keys(settingValues).forEach(key => delete settingValues[key]);
  const modes = ["edit", "paint"];
  moveTool = { modes, condition: { modes } };
  outlinerPanel = { condition: { modes: ["edit", "paint", "animate"] } };
  projects = [{ uuid: "a", mode: SCRATCHPAD_MODE_ID }, { uuid: "b", mode: "paint" }];
  return {
    Mode: HostMode,
    KeybindItem: HostKeybindItem,
    Modes: { selected: false, options: { edit: { trigger: () => triggered.push("edit") } } },
    Settings: { get: (id: string) => settingValues[id] },
    Project: { uuid: "a" },
    ModelProject: { all: projects },
    Format: bedrockFormat(),
    BarItems: { move_tool: moveTool, screenshot: { condition: () => true } },
    Panels: { outliner: outlinerPanel, preview: {} },
    Canvas: { buildGrid: () => { gridBuilds += 1; } },
    Blockbench: {
      on: (event: string, listener: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      removeListener: (event: string, listener: Listener) =>
        listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener)),
    },
    tl: (key: string) => key,
  };
});

function registeredMode(): HostMode {
  const [mode] = HostMode.registered;
  if (!mode) throw new Error("Scratchpad mode was not registered.");
  return mode;
}

describe("guardrail relaxation", () => {
  test("relaxes every format guardrail and restores the captured values", () => {
    const format = bedrockFormat();
    const original = snapshotGuardrails(format);
    const restore = relaxGuardrails(format);

    expect(snapshotGuardrails(format)).toEqual(RELAXED_GUARDRAILS);
    expect(format.cube_size_limiter).toBeUndefined();

    restore();
    expect(snapshotGuardrails(format)).toEqual(original);
    expect(format.cube_size_limiter).toBe(original.cube_size_limiter);
  });

  test("restore keeps flags that something else changed while relaxed", () => {
    const format = bedrockFormat();
    const restore = relaxGuardrails(format);
    const limiter = { test: () => false };
    format.cube_size_limiter = limiter;
    restore();
    expect(format.cube_size_limiter).toBe(limiter);
    expect(format.rotation_limit).toBe(true);
    restore();
    expect(format.integer_size).toBe(true);
  });

  test("relaxing without a format is a no-op", () => {
    expect(() => relaxGuardrails(undefined)()).not.toThrow();
    expect(() => relaxGuardrails(null)()).not.toThrow();
  });
});

describe("edit mode aliasing", () => {
  test("collects tool and panel mode arrays, aliases edit once, and reverts", () => {
    const aliased = new Set<string[]>();
    const arrays = collectModeArrays([{ move_tool: moveTool, other: { condition: { modes: ["paint"] } } }, { outliner: outlinerPanel }]);
    aliasEditMode("ai_scratchpad", arrays, aliased);
    aliasEditMode("ai_scratchpad", arrays, aliased);

    expect(moveTool.modes).toEqual(["edit", "paint", "ai_scratchpad"]);
    expect(moveTool.condition.modes).toBe(moveTool.modes);
    expect(outlinerPanel.condition.modes).toEqual(["edit", "paint", "animate", "ai_scratchpad"]);
    expect(aliased.size).toBe(2);

    removeEditAlias("ai_scratchpad", aliased);
    expect(moveTool.modes).toEqual(["edit", "paint"]);
    expect(outlinerPanel.condition.modes).toEqual(["edit", "paint", "animate"]);
    expect(aliased.size).toBe(0);
  });
});

describe("scratchpad condition", () => {
  test("requires the setting, an open project, and a format with edit mode", () => {
    expect(scratchpadCondition()).toBe(false);
    settingValues[SETTING_SCRATCHPAD_ENABLED] = true;
    expect(scratchpadCondition()).toBe(true);

    Object.assign(globalThis, { Format: { ...bedrockFormat(), edit_mode: false } });
    expect(scratchpadCondition()).toBe(false);

    Object.assign(globalThis, { Format: bedrockFormat(), Project: null });
    expect(scratchpadCondition()).toBe(false);
  });
});

describe("mode lifecycle", () => {
  test("registers once, aliases edit-gated host items, and relaxes the live format on select", () => {
    settingValues[SETTING_SCRATCHPAD_ENABLED] = true;
    setupScratchpadMode();
    setupScratchpadMode();
    expect(HostMode.registered.map(mode => mode.id)).toEqual([SCRATCHPAD_MODE_ID]);
    expect(moveTool.modes).toContain(SCRATCHPAD_MODE_ID);
    expect(outlinerPanel.condition.modes).toContain(SCRATCHPAD_MODE_ID);
    expect(listeners.get("convert_format")).toHaveLength(1);

    const mode = registeredMode();
    expect(mode.options.name).toBe("mcp.mode.ai_scratchpad");
    expect(mode.options.condition).toBe(scratchpadCondition);

    mode.options.onSelect?.();
    expect(Format.rotation_limit).toBe(false);
    expect(Format.cube_size_limiter).toBeUndefined();
    expect(gridBuilds).toBe(1);

    mode.options.onUnselect?.();
    expect(Format.rotation_limit).toBe(true);
    expect(Format.cube_size_limiter).toBeDefined();
    expect(gridBuilds).toBe(2);

    teardownScratchpadMode();
    expect(HostMode.deleted).toEqual([SCRATCHPAD_MODE_ID]);
    expect(HostKeybindItem.deleted).toEqual([mode]);
    expect(moveTool.modes).not.toContain(SCRATCHPAD_MODE_ID);
    expect(listeners.get("convert_format")).toHaveLength(0);
    teardownScratchpadMode();
    expect(HostMode.deleted).toHaveLength(1);
  });

  test("teardown rewrites stored project modes and restores guardrails even if the host skips unselect", () => {
    settingValues[SETTING_SCRATCHPAD_ENABLED] = true;
    setupScratchpadMode();
    registeredMode().options.onSelect?.();
    expect(Format.integer_size).toBe(false);

    teardownScratchpadMode();
    expect(Format.integer_size).toBe(true);
    expect(projects.map(project => project.mode)).toEqual(["edit", "paint"]);
  });

  test("entry through a bypassed condition leaves guardrails alone and bounces back to edit", async () => {
    setupScratchpadMode();
    Object.assign(globalThis, { Modes: { selected: { id: SCRATCHPAD_MODE_ID }, options: { edit: { trigger: () => triggered.push("edit") } } } });
    registeredMode().options.onSelect?.();
    expect(Format.rotation_limit).toBe(true);
    expect(triggered).toEqual([]);

    await flushMicrotasks();
    expect(triggered).toEqual(["edit"]);
    teardownScratchpadMode();
  });

  test("a format conversion inside the scratchpad moves the relaxation to the new format", () => {
    settingValues[SETTING_SCRATCHPAD_ENABLED] = true;
    setupScratchpadMode();
    const oldFormat = Format as unknown as IGuardrailFlags;
    Object.assign(globalThis, { Modes: { selected: { id: SCRATCHPAD_MODE_ID }, options: { edit: { trigger: () => triggered.push("edit") } } } });
    registeredMode().options.onSelect?.();
    expect(oldFormat.rotation_limit).toBe(false);

    const newFormat = bedrockFormat();
    Object.assign(globalThis, { Format: newFormat });
    dispatch("convert_format");
    expect(oldFormat.rotation_limit).toBe(true);
    expect(newFormat.rotation_limit).toBe(false);

    registeredMode().options.onUnselect?.();
    expect(newFormat.rotation_limit).toBe(true);
    teardownScratchpadMode();
  });
});

describe("setting change", () => {
  test("disabling the toggle while the scratchpad is selected returns to edit and scrubs stored modes", () => {
    Object.assign(globalThis, { Modes: { selected: { id: SCRATCHPAD_MODE_ID }, options: { edit: { trigger: () => triggered.push("edit") } } } });
    onScratchpadSettingChanged(false);
    expect(triggered).toEqual(["edit"]);
    expect(projects.map(project => project.mode)).toEqual(["edit", "paint"]);
  });

  test("toggling in another mode or enabling leaves the active mode alone", () => {
    Object.assign(globalThis, { Modes: { selected: { id: "edit" }, options: { edit: { trigger: () => triggered.push("edit") } } } });
    onScratchpadSettingChanged(false);
    onScratchpadSettingChanged(true);
    expect(triggered).toEqual([]);
  });
});
