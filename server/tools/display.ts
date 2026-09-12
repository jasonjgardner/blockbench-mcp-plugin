/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
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
  slot: displaySlotEnum.describe("Display slot to modify."),
  // Each vector uses a fresh schema instance (via vec3) so the advertised JSON
  // schema stays fully inlined rather than collapsing repeated instances into a
  // bare, unresolved `$ref`. See issue #44.
  translation: vec3(
    "Translation offset as [x, y, z] (Minecraft display units)."
  ).optional(),
  rotation: vec3("Rotation in degrees as [x, y, z].").optional(),
  scale: vec3("Scale factor as [x, y, z].").optional(),
  rotation_pivot: vec3("Rotation pivot point as [x, y, z].").optional(),
  scale_pivot: vec3("Scale pivot point as [x, y, z].").optional(),
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
      "Reset the slot to its default (identity) transform before applying any of the other values."
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

export const displayToolDocs: ToolSpec[] = [
  {
    name: "get_display_transform",
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
    description:
      "Writes a Java Edition display slot's transform (translation, rotation, scale, mirror, pivots). Creates the slot if it does not exist yet and wraps the change in an undo step. This edits data that ships in the exported model JSON — it changes the deliverable, not just the preview. Requires a format that supports display mode (e.g. Java Block/Item).",
    annotations: {
      title: "Set Display Transform",
      destructiveHint: true,
    },
    parameters: setDisplayTransformParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "enter_display_mode",
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
  display_slot?: string;
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

        // Create the slot on demand, mirroring Blockbench's own loadDisp().
        let displaySlot = settings[slot];
        if (!displaySlot) {
          displaySlot = new DisplaySlot(slot, {});
          settings[slot] = displaySlot;
        }

        if (reset) {
          displaySlot.default();
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

        return JSON.stringify(
          {
            slot,
            reset: Boolean(reset),
            transform: serializeSlot(displaySlot),
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

        // 2. Activate the requested slot. Slot-activation internals differ
        //    across Blockbench versions, so try the canonical entry point first
        //    and fall back to older/global variants, reporting which worked.
        const displayModeRuntime = DisplayMode as unknown as IDisplayModeRuntime;
        const loadDisp = (
          globalThis as unknown as { loadDisp?: (slot: string) => void }
        ).loadDisp;

        const activateSlot = (): string => {
          if (typeof displayModeRuntime.load === "function") {
            displayModeRuntime.load(slot);
            return "DisplayMode.load";
          }
          if (typeof loadDisp === "function") {
            loadDisp(slot);
            return "loadDisp";
          }
          displayModeRuntime.display_slot = slot;
          return "DisplayMode.display_slot";
        };
        notes.push(`Activated slot "${slot}" via ${activateSlot()}.`);

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
