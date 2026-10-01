/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { captureScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import { displaySlotEnum, vec3 } from "@/lib/zodObjects";

// ============================================================================
// Display Settings Tool Parameter Schemas
// ============================================================================

export const getDisplayTransformParameters = z.object({
  slot: displaySlotEnum
    .optional()
    .describe(
      "Display slot to read. If omitted, returns every populated slot in the project."
    ),
});

export const setDisplayTransformParameters = z.object({
  slot: displaySlotEnum.describe("Display slot to modify. embedded is a Bedrock block slot that Minecraft Java ignores."),
  // Each vector uses a fresh schema instance (via vec3) so the advertised JSON
  // schema stays fully inlined rather than collapsing repeated instances into a
  // bare, unresolved `$ref`. See issue #44.
  translation: vec3(
    "Translation offset as [x, y, z] (Minecraft display units, 1/16 block). Minecraft Java clamps each component to ±80."
  ).optional(),
  rotation: vec3("Rotation in degrees as [x, y, z].").optional(),
  scale: vec3("Scale factor as [x, y, z]; a negative component mirrors that axis. Minecraft Java clamps each exported component to ±4.").optional(),
  rotation_pivot: vec3("Rotation pivot point as [x, y, z]. Only Bedrock reads pivots; Minecraft Java ignores them.").optional(),
  scale_pivot: vec3("Scale pivot point as [x, y, z]. Only Bedrock reads pivots; Minecraft Java ignores them.").optional(),
  mirror: z
    .array(z.boolean())
    .length(3)
    .optional()
    .describe("Per-axis mirror flags as [x, y, z]."),
  reset: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Reset the slot to its default transform before applying any of the other values: identity, or Blockbench's Bedrock defaults on bedrock_block projects."
    ),
});

export const enterDisplayModeParameters = z.object({
  slot: displaySlotEnum.describe("Display slot to switch to and activate."),
  reference: z
    .string()
    .optional()
    .describe(
      "Optional reference model to load for a fit check (e.g. 'player', 'zombie', 'armor_stand', 'baby_zombie', 'block'). Validated against the live reference model list; an unknown value returns the available names."
    ),
});

// ============================================================================
// Display Settings Tool Docs
// ============================================================================

export const displayToolDocs: IToolSpec[] = [
  {
    name: "get_display_transform",
    condition: { project: true, features: ["display_mode"] },
    description:
      "Reads Java Edition display settings (Project.display_settings). Returns translation, rotation, scale, mirror and pivots for a single slot, or a summary of every populated slot when no slot is given. Never modifies state.",
    annotations: {
      title: "Get Display Transform",
      readOnlyHint: true,
    },
    parameters: getDisplayTransformParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "set_display_transform",
    condition: { project: true, features: ["display_mode"] },
    description:
      "Writes a Java Edition display slot's transform (translation, rotation, scale, mirror, pivots). Creates the slot if it does not exist yet (seeded from Blockbench's Bedrock item display defaults on bedrock_block projects, identity otherwise) and wraps the change in an undo step. This edits data that ships in the exported model JSON — it changes the deliverable, not just the preview. Values are kept as given, like Blockbench does; outside bedrock_block projects the result warns about those Minecraft Java clamps or ignores (translation beyond ±80, scale beyond ±4, pivots, the embedded slot). Requires a format that supports display mode (e.g. Java Block/Item).",
    annotations: {
      title: "Set Display Transform",
      destructiveHint: true,
    },
    parameters: setDisplayTransformParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "enter_display_mode",
    condition: { project: true, features: ["display_mode"] },
    description:
      "Switches Blockbench into Display mode, activates the given slot and optionally loads a reference model (player, zombie, armor stand, …), then returns a screenshot. Pair with set_camera_angle / capture_screenshot for multi-angle fit checks of cosmetics and handheld items. Requires a format that supports display mode.",
    annotations: {
      title: "Enter Display Mode",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: enterDisplayModeParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

// ============================================================================
// Runtime shims for Blockbench globals not covered by blockbench-types
// ============================================================================

/** Subset of the runtime DisplayMode global used here (types only cover `slots`). */
interface IDisplayModeRuntime {
  load?: (slot: string) => void;
  /** Blockbench 5.2+: per-slot Bedrock item display defaults used by bedrock_block projects. */
  bedrock_defaults?: Record<string, DisplaySlotOptions | undefined>;
}

/**
 * Returns the default transform a new or reset slot should start from.
 *
 * Blockbench 5.2 seeds Bedrock block display slots from
 * `DisplayMode.bedrock_defaults` (extracted from the Bedrock client) when
 * importing and when applying the block preset, so a slot created or reset
 * with plain identity values would not match what the game uses. Other
 * formats, and older hosts without the table, use identity.
 *
 * @param slot - Display slot ID.
 * @returns The Bedrock defaults for the slot, or `undefined` for identity.
 */
function getSlotDefaults(slot: string): DisplaySlotOptions | undefined {
  if (Format?.id !== "bedrock_block") return undefined;
  return (DisplayMode as unknown as IDisplayModeRuntime).bedrock_defaults?.[slot];
}

/** Subset of the runtime displayReferenceObjects global (not in blockbench-types). */
interface IDisplayReferenceObjects {
  refmodels?: Record<string, { load?: (index?: number) => void }>;
}

/**
 * Serializes a DisplaySlot into a plain, JSON-friendly transform object.
 *
 * @param slot - The DisplaySlot instance to read.
 * @returns The slot's translation, rotation, scale, mirror and pivot values.
 */
function serializeSlot(slot: DisplaySlot) {
  return {
    translation: slot.translation,
    rotation: slot.rotation,
    scale: slot.scale,
    mirror: slot.mirror,
    rotation_pivot: slot.rotation_pivot,
    scale_pivot: slot.scale_pivot,
  };
}

/**
 * Largest translation component Minecraft Java keeps: its item model loader
 * (`ItemTransform.Deserializer` in 26.3) divides it by 16 and clamps the
 * result to ±5 blocks.
 */
const JAVA_MAX_TRANSLATION = 80;

/** Largest scale magnitude Minecraft Java keeps: its item model loader clamps each component to ±4. */
const JAVA_MAX_SCALE = 4;

/** Display contexts (`ItemDisplayContext`; `on_shelf` is the newest) that Minecraft Java reads from a model's display block. */
const JAVA_DISPLAY_SLOTS: ReadonlySet<string> = new Set([
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
  "head",
  "gui",
  "ground",
  "fixed",
  "on_shelf",
]);

/** The slot values the Java checks read. Blockbench stores scale as magnitudes plus mirror flags. */
export interface IJavaDisplayValues {
  translation: number[];
  scale: number[];
  mirror: boolean[];
  rotation_pivot: number[];
  scale_pivot: number[];
}

function formatVector(values: number[]): string {
  return `[${values.join(", ")}]`;
}

/**
 * Explains the parts of a display slot that Minecraft Java ignores or clamps
 * when it loads the exported model (in 26.3: `ItemTransform.Deserializer`,
 * `ItemTransforms`), so the in-game result differs from Blockbench's preview.
 * Scale is checked as exported: `DisplaySlot.export` writes each magnitude
 * negated where the axis is mirrored. Values are reported, not changed:
 * Blockbench keeps them, and other targets may read them.
 *
 * @param slot - Display slot ID.
 * @param values - The slot's resulting transform.
 * @returns One message per problem; empty when the game uses the slot as is.
 */
export function javaDisplayWarnings(slot: string, values: IJavaDisplayValues): string[] {
  const warnings: string[] = [];
  if (!JAVA_DISPLAY_SLOTS.has(slot)) {
    warnings.push(`Minecraft Java has no "${slot}" display context, so it ignores this slot; Blockbench uses it for Bedrock blocks.`);
  }
  if (values.translation.some((value) => Math.abs(value) > JAVA_MAX_TRANSLATION)) {
    const clamped = values.translation.map((value) => Math.min(JAVA_MAX_TRANSLATION, Math.max(-JAVA_MAX_TRANSLATION, value)));
    warnings.push(`translation ${formatVector(values.translation)} exceeds ±${JAVA_MAX_TRANSLATION} (5 blocks); Minecraft Java clamps it to ${formatVector(clamped)}.`);
  }
  const scale = values.scale.map((value, index) => (values.mirror[index] ? -value : value));
  if (scale.some((value) => Math.abs(value) > JAVA_MAX_SCALE)) {
    const clamped = scale.map((value) => Math.min(JAVA_MAX_SCALE, Math.max(-JAVA_MAX_SCALE, value)));
    warnings.push(`scale ${formatVector(scale)} exceeds ±${JAVA_MAX_SCALE}; Minecraft Java clamps it to ${formatVector(clamped)}.`);
  }
  (["rotation_pivot", "scale_pivot"] as const)
    .filter((key) => values[key].some((value) => value !== 0))
    .forEach((key) => warnings.push(`${key} ${formatVector(values[key])} only affects Bedrock; Minecraft Java ignores it.`));
  return warnings;
}

/**
 * Ensures a project is open, throwing an actionable error otherwise.
 *
 * @returns The live `Project.display_settings` map, typed as DisplaySlot values.
 * @throws When no project is open.
 */
function getDisplaySettingsOrThrow(): Record<string, DisplaySlot> {
  if (!Project) {
    throw new Error(
      "No project is open. Create or open a project before working with display settings."
    );
  }
  return Project.display_settings as unknown as Record<string, DisplaySlot>;
}

/**
 * Guards that the active format supports Java Edition display settings.
 *
 * @throws When the current format has no display mode.
 */
function assertDisplayModeSupported(): void {
  if (!Format?.display_mode) {
    throw new Error(
      "The current format does not support Java Edition display settings. Display transforms only apply to formats with a display mode, such as Java Block/Item."
    );
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerDisplayTools() {
  createTool(
    displayToolDocs[0].name,
    {
      ...displayToolDocs[0],
      async execute({ slot }) {
        const settings = getDisplaySettingsOrThrow();

        if (slot) {
          const displaySlot = settings[slot];
          return JSON.stringify(
            {
              slot,
              present: Boolean(displaySlot),
              transform: displaySlot
                ? serializeSlot(displaySlot)
                : null,
              note: displaySlot
                ? undefined
                : "Slot is not set; it exports at the default identity transform.",
            },
            null,
            2
          );
        }

        const slots = Object.entries(settings).map(([id, displaySlot]) => ({
          slot: id,
          ...serializeSlot(displaySlot),
        }));

        return JSON.stringify(
          {
            format_supports_display: Boolean(Format?.display_mode),
            populated_count: slots.length,
            slots,
          },
          null,
          2
        );
      },
    },
    displayToolDocs[0].status
  );

  createTool(
    displayToolDocs[1].name,
    {
      ...displayToolDocs[1],
      async execute({
        slot,
        translation,
        rotation,
        scale,
        rotation_pivot,
        scale_pivot,
        mirror,
        reset,
      }) {
        const settings = getDisplaySettingsOrThrow();
        assertDisplayModeSupported();

        Undo.initEdit({ display_slots: [slot] });

        // Create the slot on demand like Blockbench's loadDisp(), seeded from
        // the format's defaults (Bedrock defaults on bedrock_block).
        const slotDefaults = getSlotDefaults(slot);
        const existingSlot = settings[slot];
        const displaySlot = existingSlot ?? new DisplaySlot(slot, slotDefaults ?? {});
        if (!existingSlot) settings[slot] = displaySlot;

        if (reset) {
          displaySlot.default();
          if (slotDefaults) displaySlot.extend(slotDefaults);
        }

        // Only forward the fields the caller actually supplied so unspecified
        // components keep their current values.
        const data: DisplaySlotOptions = {
          ...(translation && { translation: translation as ArrayVector3 }),
          ...(rotation && { rotation: rotation as ArrayVector3 }),
          ...(scale && { scale: scale as ArrayVector3 }),
          ...(rotation_pivot && {
            rotation_pivot: rotation_pivot as ArrayVector3,
          }),
          ...(scale_pivot && { scale_pivot: scale_pivot as ArrayVector3 }),
          ...(mirror && { mirror: mirror as [boolean, boolean, boolean] }),
        };
        displaySlot.extend(data);
        displaySlot.update();

        Undo.finishEdit("Agent set display transform");
        Canvas.updateAll();

        const transform = serializeSlot(displaySlot);
        return JSON.stringify(
          {
            slot,
            reset: Boolean(reset),
            defaults: slotDefaults ? "bedrock_block" : "identity",
            transform,
            // bedrock_block slots export to Bedrock's item_display_transforms, which the Java limits do not govern.
            warnings: Format?.id === "bedrock_block" ? [] : javaDisplayWarnings(slot, transform),
          },
          null,
          2
        );
      },
    },
    displayToolDocs[1].status
  );

  createTool(
    displayToolDocs[2].name,
    {
      ...displayToolDocs[2],
      async execute({ slot, reference }) {
        if (!Project) {
          throw new Error(
            "No project is open. Create or open a project before entering display mode."
          );
        }
        assertDisplayModeSupported();

        const notes: string[] = [];

        // 1. Enter display mode if not already active. Selecting the mode runs
        //    enterDisplaySettings() synchronously (sets up the display preview).
        const alreadyDisplay = Boolean(Modes.display);
        if (!alreadyDisplay) {
          const displayMode = Modes.options.display;
          if (!displayMode) {
            throw new Error(
              "Display mode is unavailable in this Blockbench build."
            );
          }
          displayMode.select();
        }
        notes.push(
          alreadyDisplay ? "Already in display mode." : "Entered display mode."
        );

        // 2. Activate the requested slot. `DisplayMode.load(slot)` is the
        //    window-exposed entry point (Blockbench 4.x–5.2) that dispatches to
        //    the per-slot loaders (loadThirdRight, loadGUI, …), which call the
        //    module-scoped loadDisp() and position the preview camera. loadDisp
        //    itself is not a window global, so there is no other path to try.
        const displayModeRuntime = DisplayMode as unknown as IDisplayModeRuntime;
        if (typeof displayModeRuntime.load !== "function") {
          throw new Error(
            "This Blockbench build does not expose DisplayMode.load, so display slots cannot be switched programmatically."
          );
        }
        displayModeRuntime.load(slot);
        notes.push(`Activated slot "${slot}".`);

        // 3. Load the reference model, if requested.
        if (reference) {
          const refObjects = (
            globalThis as unknown as {
              displayReferenceObjects?: IDisplayReferenceObjects;
            }
          ).displayReferenceObjects;
          const refModel = refObjects?.refmodels?.[reference];
          if (!refModel) {
            const available = refObjects?.refmodels
              ? Object.keys(refObjects.refmodels).join(", ")
              : "none available";
            throw new Error(
              `Reference model "${reference}" not found. Available references: ${available}.`
            );
          }
          refModel.load?.();
          notes.push(`Loaded reference model "${reference}".`);
        }

        // 4. Return a screenshot of the display preview alongside the notes.
        const shot = captureScreenshot();
        return {
          content: [
            { type: "text" as const, text: notes.join(" ") },
            ...shot.content,
          ],
        };
      },
    },
    displayToolDocs[2].status
  );
}
