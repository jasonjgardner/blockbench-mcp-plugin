import { beforeAll, beforeEach, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";
import { isRecord } from "@/tests/helpers/assertions";

type Vector = [number, number, number];

/** Slot values as `DisplaySlot.extend` receives them. */
interface ISlotData {
  rotation?: Vector;
  translation?: Vector;
  scale?: Vector;
  rotation_pivot?: Vector;
  scale_pivot?: Vector;
  mirror?: [boolean, boolean, boolean];
}

/** Mirrors Blockbench's DisplaySlot: scale is stored as a magnitude and a negative input sets the mirror flag. */
class TestDisplaySlot {
  rotation: Vector = [0, 0, 0];
  translation: Vector = [0, 0, 0];
  scale: Vector = [1, 1, 1];
  rotation_pivot: Vector = [0, 0, 0];
  scale_pivot: Vector = [0, 0, 0];
  mirror: [boolean, boolean, boolean] = [false, false, false];
  constructor(readonly slot_id: string, data: ISlotData = {}) {
    this.extend(data);
  }
  default(): this {
    Object.assign(this, new TestDisplaySlot(this.slot_id));
    return this;
  }
  extend(data: ISlotData): this {
    [0, 1, 2].forEach(i => {
      if (data.rotation) this.rotation[i] = data.rotation[i];
      if (data.translation) this.translation[i] = data.translation[i];
      if (data.scale) this.scale[i] = data.scale[i];
      if (data.rotation_pivot) this.rotation_pivot[i] = data.rotation_pivot[i];
      if (data.scale_pivot) this.scale_pivot[i] = data.scale_pivot[i];
      if (data.mirror) this.mirror[i] = data.mirror[i];
      if (data.scale && data.scale[i] < 0) this.mirror[i] = true;
      this.scale[i] = Math.abs(this.scale[i]);
    });
    return this;
  }
  update(): this {
    return this;
  }
}

let tools: IToolFixture;
let project: { display_settings: Record<string, TestDisplaySlot> };
let format: { id: string; display_mode: boolean };

const undo = createUndoHost({
  snapshot: (_aspects: { display_slots: string[] }) => JSON.stringify(project.display_settings),
  restore: (saved: string) => {
    const data: Record<string, ISlotData> = JSON.parse(saved);
    project.display_settings = Object.fromEntries(Object.entries(data).map(([slot, values]) => [slot, new TestDisplaySlot(slot, values)]));
  },
});

async function setTransform(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result: unknown = JSON.parse(String(await tools.call("set_display_transform", input)));
  if (!isRecord(result)) throw new Error("set_display_transform did not return a JSON object.");
  return result;
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/display.ts"], register: ["registerDisplayTools"] });
});
beforeEach(() => {
  project = { display_settings: {} };
  format = { id: "java_block", display_mode: true };
  undo.reset();
});
useGlobals(() => ({
  Canvas: { updateAll() {} },
  DisplayMode: { bedrock_defaults: {} },
  DisplaySlot: TestDisplaySlot,
  Format: format,
  Project: project,
  Undo: undo,
}));

test("values Minecraft Java clamps or ignores are kept and reported, with scale checked as exported", async () => {
  const result = await setTransform({
    slot: "embedded",
    translation: [100, 0, -90],
    scale: [-6, 1, 2],
    rotation_pivot: [0, 8, 0],
    scale_pivot: [0, 0.5, 0],
  });
  // Blockbench keeps the values; only the warnings describe what the game will do.
  expect(result.transform).toMatchObject({ translation: [100, 0, -90], scale: [6, 1, 2], mirror: [true, false, false] });
  expect(result.warnings).toEqual([
    'Minecraft Java has no "embedded" display context, so it ignores this slot; Blockbench uses it for Bedrock blocks.',
    "translation [100, 0, -90] exceeds ±80 (5 blocks); Minecraft Java clamps it to [80, 0, -80].",
    // Blockbench exports the mirrored axis as a negative scale, so the game clamps -6 to -4.
    "scale [-6, 1, 2] exceeds ±4; Minecraft Java clamps it to [-4, 1, 2].",
    "rotation_pivot [0, 8, 0] only affects Bedrock; Minecraft Java ignores it.",
    "scale_pivot [0, 0.5, 0] only affects Bedrock; Minecraft Java ignores it.",
  ]);
  expect(undo.history).toHaveLength(1);
});

test("values within Minecraft's limits carry no warning", async () => {
  const result = await setTransform({ slot: "gui", translation: [80, -80, 0], scale: [4, 0.5, 4], rotation: [30, 225, 0] });
  expect(result.warnings).toEqual([]);
});

test("warnings describe the resulting slot, not only the values of this call", async () => {
  await setTransform({ slot: "head", translation: [0, 120, 0] });
  const result = await setTransform({ slot: "head", rotation: [0, 180, 0] });
  expect(result.warnings).toEqual(["translation [0, 120, 0] exceeds ±80 (5 blocks); Minecraft Java clamps it to [0, 80, 0]."]);
});

test("Bedrock block slots are not held to Java limits", async () => {
  format.id = "bedrock_block";
  const result = await setTransform({ slot: "embedded", translation: [100, 0, 0], rotation_pivot: [0, 8, 0] });
  expect(result.warnings).toEqual([]);
});
