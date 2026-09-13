import { beforeAll, beforeEach, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCondition } from "@/server/tool-conditions";
import { isRecord, required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

interface IHostMode {
  id: string;
  name: string;
  condition: ToolCondition;
  selected: boolean;
  triggerCalls: number;
  selectCalls: number;
  select(): void;
  trigger(): void;
}

interface IHostModes {
  readonly id: string;
  options: Record<string, IHostMode>;
  selected: IHostMode | false;
}

let tools: IToolFixture;
let project: { mode: string } | null;
let format: Record<string, boolean>;
let modes: IHostModes;
let modeClass: { selected: IHostMode | false };
let checkedConditions: ToolCondition[];
let events: string[];
let animatorOpen: boolean;

// Emulate the small native Condition surface used by these host modes. The
// identity assertions below ensure tools delegate each decision to this API.
function nativeCondition(condition: ToolCondition): boolean {
  checkedConditions.push(condition);
  if (typeof condition === "function") return Boolean(condition());
  if (typeof condition !== "object") return condition !== false;
  if (condition.project && !project) return false;
  if (condition.features?.some(feature => !format[feature])) return false;
  return condition.method?.() ?? true;
}

function createMode(id: string, condition: ToolCondition = true): IHostMode {
  return {
    id,
    name: id === "animate" ? "Animate" : id,
    condition,
    selected: false,
    triggerCalls: 0,
    selectCalls: 0,
    select() {
      this.selectCalls++;
      if (modes.selected) {
        modes.selected.selected = false;
        events.push(`unselect_mode:${modes.selected.id}`);
      }
      this.selected = true;
      modes.selected = this;
      modeClass.selected = this;
      if (project) project.mode = this.id;
      animatorOpen = this.id === "animate";
      events.push(`select_mode:${this.id}`);
    },
    trigger() {
      this.triggerCalls++;
      if (nativeCondition(this.condition)) this.select();
    },
  };
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/modes.ts"], register: ["registerModeTools"] });
});

beforeEach(() => {
  project = { mode: "edit" };
  format = { animation_mode: true };
  checkedConditions = [];
  events = [];
  animatorOpen = false;
  modeClass = { selected: false };
  modes = {
    get id() { return this.selected ? this.selected.id : ""; },
    options: {
      edit: createMode("edit", { project: true }),
      animate: createMode("animate", { project: true, features: ["animation_mode"] }),
      display: createMode("display", false),
    },
    selected: false,
  };
  const edit = required(modes.options.edit, "edit mode");
  edit.selected = true;
  modes.selected = edit;
  modeClass.selected = edit;
});

useGlobals(() => ({
  Condition: nativeCondition,
  Format: format,
  Mode: modeClass,
  Modes: modes,
  Project: project,
}));

async function call(name: "list_modes" | "set_mode", input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = CallToolResultSchema.parse(await tools.call(name, input));
  const item = result.content.find(content => content.type === "text");
  if (!item || item.type !== "text") throw new Error("Expected JSON mode result.");
  const parsed: unknown = JSON.parse(item.text);
  expect(parsed).toEqual(result.structuredContent);
  if (!isRecord(parsed)) throw new Error("Expected structured mode metadata.");
  return parsed;
}

test("mode discovery reports the current tab and native availability without running mode hooks", async () => {
  const result = await call("list_modes");
  expect(result.current_mode).toBe("edit");
  expect(result.modes).toEqual(expect.arrayContaining([
    { id: "edit", name: "edit", available: true, selected: true },
    { id: "animate", name: "Animate", available: true, selected: false },
    { id: "display", name: "display", available: false, selected: false },
  ]));
  expect(checkedConditions).toContain(required(modes.options.animate, "animate mode").condition);
  expect(events).toEqual([]);
  expect(Object.values(modes.options).every(mode => mode.triggerCalls === 0 && mode.selectCalls === 0)).toBe(true);
});

test("Edit to Animate uses native activation and returns the resulting selection", async () => {
  const animate = required(modes.options.animate, "animate mode");
  expect(await call("set_mode", { mode_id: "animate" })).toMatchObject({
    previous_mode: "edit", current_mode: "animate", changed: true,
    modes: expect.arrayContaining([{ id: "animate", name: "Animate", available: true, selected: true }]),
  });
  expect(animate.triggerCalls).toBe(1);
  expect(animate.selectCalls).toBe(1);
  expect(animatorOpen).toBe(true);
  expect(project?.mode).toBe("animate");
  expect(events).toEqual(["unselect_mode:edit", "select_mode:animate"]);
});

test("selecting the active mode is idempotent and leaves native hooks alone", async () => {
  expect(await call("set_mode", { mode_id: "edit" })).toMatchObject({
    previous_mode: "edit", current_mode: "edit", changed: false,
  });
  const edit = required(modes.options.edit, "edit mode");
  expect(edit.triggerCalls).toBe(0);
  expect(edit.selectCalls).toBe(0);
  expect(events).toEqual([]);
});

test("unavailable modes reject before native selection or project mutation", async () => {
  format.animation_mode = false;
  const animate = required(modes.options.animate, "animate mode");
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/unavailable/i);
  expect(checkedConditions).toContain(animate.condition);
  expect(animate.triggerCalls).toBe(0);
  expect(animate.selectCalls).toBe(0);
  expect(modes.id).toBe("edit");
  expect(project?.mode).toBe("edit");
  expect(events).toEqual([]);
});

test("plugin modes registered after MCP startup are discovered and selectable", async () => {
  const custom = createMode("plugin_preview", () => true);
  custom.name = "Plugin Preview";
  modes.options.plugin_preview = custom;
  expect((await call("list_modes")).modes).toContainEqual({
    id: "plugin_preview", name: "Plugin Preview", available: true, selected: false,
  });
  expect(await call("set_mode", { mode_id: "plugin_preview" })).toMatchObject({
    previous_mode: "edit", current_mode: "plugin_preview", changed: true,
  });
  expect(custom.triggerCalls).toBe(1);
});

test("a removed plugin mode and inherited registry identifiers cannot be activated", async () => {
  modes.options.removed = createMode("removed");
  delete modes.options.removed;
  await expect(call("set_mode", { mode_id: "removed" })).rejects.toThrow(/not found/i);
  await expect(call("set_mode", { mode_id: "toString" })).rejects.toThrow(/not found/i);
  await expect(call("set_mode", { mode_id: "__proto__" })).rejects.toThrow(/not found/i);
  expect(events).toEqual([]);
});

test("a throwing plugin condition disables only that mode", async () => {
  const broken = createMode("broken", () => { throw new Error("Plugin condition failed"); });
  modes.options.broken = broken;
  const result = await call("list_modes");
  expect(result.modes).toContainEqual({ id: "broken", name: "broken", available: false, selected: false });
  expect(result.modes).toContainEqual({ id: "animate", name: "Animate", available: true, selected: false });
  await expect(call("set_mode", { mode_id: "broken" })).rejects.toThrow(/unavailable/i);
  expect(broken.triggerCalls).toBe(0);
});

test("discovery stays callable with no selected project or mode", async () => {
  project = null;
  modes.selected = false;
  modeClass.selected = false;
  Object.values(modes.options).forEach(mode => { mode.selected = false; });
  Reflect.set(globalThis, "Project", null);
  const result = await call("list_modes");
  expect(result.current_mode).toBeNull();
  expect(result.modes).toEqual(expect.arrayContaining([
    { id: "edit", name: "edit", available: false, selected: false },
    { id: "animate", name: "Animate", available: false, selected: false },
  ]));
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/unavailable/i);
  expect(Reflect.get(tools.get("list_modes"), "condition")).toBeUndefined();
  expect(Reflect.get(tools.get("set_mode"), "condition")).toBeUndefined();
});

test("an empty runtime mode registry remains discoverable", async () => {
  modes.options = {};
  modes.selected = false;
  modeClass.selected = false;
  expect(await call("list_modes")).toMatchObject({ current_mode: null, modes: [] });
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/not found/i);
});

test("native condition changes between discovery and activation are respected", async () => {
  let conditionCalls = 0;
  const animate = required(modes.options.animate, "animate mode");
  animate.condition = () => ++conditionCalls === 1;
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/did not enter/i);
  expect(conditionCalls).toBe(2);
  expect(animate.triggerCalls).toBe(1);
  expect(animate.selectCalls).toBe(0);
  expect(modes.id).toBe("edit");
});

test("native trigger refusal is reported instead of claiming the mode changed", async () => {
  const animate = required(modes.options.animate, "animate mode");
  animate.trigger = () => { animate.triggerCalls++; };
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/did not enter/i);
  expect(animate.triggerCalls).toBe(1);
  expect(animate.selectCalls).toBe(0);
  expect(modes.id).toBe("edit");
});

test("a plugin that redirects mode selection does not receive a false success", async () => {
  const animate = required(modes.options.animate, "animate mode");
  const redirected = createMode("redirected");
  modes.options.redirected = redirected;
  animate.trigger = () => redirected.select();
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow(/did not enter/i);
  expect(modes.id).toBe("redirected");
});

test("native hook errors propagate to the MCP error handler", async () => {
  required(modes.options.animate, "animate mode").trigger = () => { throw new Error("Animator initialization failed"); };
  await expect(call("set_mode", { mode_id: "animate" })).rejects.toThrow("Animator initialization failed");
});

test("invalid mode IDs fail schema parsing before touching runtime state", async () => {
  await expect(call("set_mode", { mode_id: "" })).rejects.toThrow();
  await expect(call("set_mode", { mode_id: 42 })).rejects.toThrow();
  await expect(call("set_mode", {})).rejects.toThrow();
  expect(checkedConditions).toEqual([]);
  expect(events).toEqual([]);
});
