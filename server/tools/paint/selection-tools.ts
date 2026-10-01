/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import { textureSelectionParameters } from "./schemas";

type SelectionInput = z.infer<typeof textureSelectionParameters>;
type SelectionMode = NonNullable<SelectionInput["mode"]>;

/**
 * Blockbench 5.2's texture selection (`IntMatrix`): one value per pixel, or a
 * single `override` for the whole texture (true = everything, false =
 * nothing). blockbench-types still describes an older rectangle API
 * (`start_x`, `invert()`, `expand()`...) that no longer exists, so the real
 * surface is typed here.
 */
interface ISelectionMatrix {
  override: boolean | null;
  get(x: number, y: number): number | boolean;
  set(x: number, y: number, value: number): void;
  clear(): void;
  setOverride(value: boolean | null): void;
}

/** Current selection as one boolean per pixel, row by row. */
function readGrid(selection: ISelectionMatrix, width: number, height: number): boolean[] {
  const grid: boolean[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid[y * width + x] = Boolean(selection.get(x, y));
  }
  return grid;
}

/** Writes a boolean grid back, using the whole-texture override when it is uniform. */
function writeGrid(selection: ISelectionMatrix, grid: boolean[], width: number): void {
  const selected = grid.filter(Boolean).length;
  if (selected === 0) {
    selection.clear();
    return;
  }
  if (selected === grid.length) {
    selection.setOverride(true);
    return;
  }
  grid.forEach((on, index) => selection.set(index % width, Math.floor(index / width), on ? 1 : 0));
}

/** Combines the current selection with a shape according to `mode`. */
function combine(before: boolean[], inShape: (index: number) => boolean, mode: SelectionMode): boolean[] {
  return before.map((was, index) => {
    const inside = inShape(index);
    switch (mode) {
      case "add": return was || inside;
      case "subtract": return was && !inside;
      case "intersect": return was && inside;
      default: return inside;
    }
  });
}

/**
 * Grows (or, with `grow` false, shrinks) the selection by a round brush of `radius` pixels: a pixel is selected
 * when any pixel (all pixels, when shrinking) within `dx² + dy² <= r²` is. Outside the texture counts as selected
 * when shrinking, so edges do not erode. Each brush row is checked with per-row prefix sums, so the cost is
 * O(width × height × radius) instead of O(width × height × radius²).
 *
 * @param before - Current selection, one boolean per pixel, row by row.
 * @returns The new selection in the same layout.
 */
export function morphSelection(before: boolean[], width: number, height: number, radius: number, grow: boolean): boolean[] {
  const r = Math.max(1, Math.round(radius));
  const prefix = Array.from({ length: height }, (_, y) => {
    const row = new Int32Array(width + 1);
    for (let x = 0; x < width; x++) row[x + 1] = row[x] + (before[y * width + x] ? 1 : 0);
    return row;
  });
  // Half-width of the brush on each row offset; sqrt is exact for perfect squares, so the disk matches dx² + dy² <= r².
  const spans = Array.from({ length: 2 * r + 1 }, (_, i) => [i - r, Math.floor(Math.sqrt(r * r - (i - r) ** 2))] as const);
  return before.map((_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const hit = ([dy, half]: readonly [number, number]): boolean => {
      const row = y + dy;
      if (row < 0 || row >= height) return !grow;
      const lo = Math.max(0, x - half);
      const hi = Math.min(width - 1, x + half);
      const inside = prefix[row][hi + 1] - prefix[row][lo];
      return grow ? inside > 0 : inside === hi - lo + 1;
    };
    return grow ? spans.some(hit) : spans.every(hit);
  });
}

/** Reads `key` from `value` when it is an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Explains why a selection change is missing from the undo history; shown to the caller. */
export const SELECTION_NOT_RECORDED_NOTE =
  "Not added to the undo history: Blockbench's selection undo only covers the texture shown in the UV editor. " +
  "Switch to Paint mode with this texture showing to make selection changes undoable.";

/**
 * Runs `edit` as one selection history entry, like the UV editor's own Select All and Invert.
 *
 * A texture selection is selection state, not bitmap content: Undo restores it from
 * `Undo.initSelection({ texture_selection: true })`. A bitmap edit would copy the image twice and leave the
 * selection in place on Ctrl+Z. When the user has turned off "Undo selections", Blockbench records nothing,
 * as it does natively.
 *
 * Blockbench saves and restores only `UVEditor.texture.selection`, and `Texture#select()` refreshes the UV
 * editor only in Paint mode. For another texture (in Edit mode right after `create_texture`, for example)
 * the before and after saves would match and the entry be dropped silently, so the next Ctrl+Z would undo
 * the previous edit instead; recording it with the UV editor pointed at the texture would not help either,
 * because Undo would restore nothing. The change is then applied without an entry and reported.
 *
 * @param texture - The texture whose selection `edit` changes.
 * @returns {@link SELECTION_NOT_RECORDED_NOTE} when the change could not be recorded, otherwise `undefined`.
 */
function recordTextureSelection(texture: Texture, label: string, edit: () => void): string | undefined {
  const recordsSelections = field(field(Reflect.get(globalThis, "settings"), "undo_selections"), "value") === true;
  if (recordsSelections && field(Reflect.get(globalThis, "UVEditor"), "texture") !== texture) {
    edit();
    return SELECTION_NOT_RECORDED_NOTE;
  }
  const save: unknown = Undo.initSelection({ texture_selection: true });
  try {
    edit();
  } catch (error) {
    if (save) Undo.cancelSelection(true);
    throw error;
  }
  Undo.finishSelection(label);
  return undefined;
}

/** Checks the inputs an action needs before any edit is opened. */
function validate({ action, coordinates, radius }: SelectionInput): void {
  if ((action === "select_rectangle" || action === "select_ellipse") && !coordinates) {
    throw new Error(`coordinates { x1, y1, x2, y2 } are required for ${action}.`);
  }
  if ((action === "expand_selection" || action === "contract_selection") && (radius === undefined || !(radius > 0))) {
    throw new Error(`A positive radius (in pixels) is required for ${action}.`);
  }
  if (action === "feather_selection") {
    throw new Error("feather_selection is not supported: Blockbench 5.2 texture selections are on/off per pixel, so there is no soft edge to feather.");
  }
}

/**
 * Registers `texture_selection` (`paintToolDocs[10]`): applies one selection
 * action to a texture's pixel selection as one selection history entry.
 */
export function registerTextureSelectionTool(): void {
  createTool(
    paintToolDocs[10].name,
    {
      ...paintToolDocs[10],
      parameters: textureSelectionParameters,
      async execute(input) {
        validate(input);
        const { action, texture_id, coordinates, radius, mode = "create" } = input;
        const texture = getAndActivateTexture(texture_id);
        const selection = texture.selection as unknown as ISelectionMatrix;
        const { width, height } = texture;

        const note = recordTextureSelection(texture, "Texture selection", () => {
          if (action === "select_all") {
            selection.setOverride(true);
            return;
          }
          if (action === "clear_selection") {
            selection.clear();
            return;
          }
          const before = readGrid(selection, width, height);
          let after: boolean[];
          if (action === "invert_selection") {
            after = before.map((was) => !was);
          } else if (action === "expand_selection" || action === "contract_selection") {
            after = morphSelection(before, width, height, radius ?? 1, action === "expand_selection");
          } else {
            // Rectangle and ellipse: pixel coordinates, both corners inclusive.
            const box = coordinates!;
            const minX = Math.min(box.x1, box.x2);
            const maxX = Math.max(box.x1, box.x2);
            const minY = Math.min(box.y1, box.y2);
            const maxY = Math.max(box.y1, box.y2);
            const inRect = (index: number): boolean => {
              const x = index % width;
              const y = Math.floor(index / width);
              return x >= minX && x <= maxX && y >= minY && y <= maxY;
            };
            const cx = (minX + maxX + 1) / 2;
            const cy = (minY + maxY + 1) / 2;
            const rx = (maxX - minX + 1) / 2;
            const ry = (maxY - minY + 1) / 2;
            const inEllipse = (index: number): boolean => {
              const dx = (index % width + 0.5 - cx) / rx;
              const dy = (Math.floor(index / width) + 0.5 - cy) / ry;
              return dx * dx + dy * dy <= 1;
            };
            after = combine(before, action === "select_ellipse" ? inEllipse : inRect, mode);
          }
          writeGrid(selection, after, width);
        });

        // Refresh the UV editor when it is mounted.
        const editor: unknown = Reflect.get(globalThis, "UVEditor");
        const vue: unknown = typeof editor === "object" && editor !== null ? Reflect.get(editor, "vue") : undefined;
        const update: unknown = typeof vue === "object" && vue !== null ? Reflect.get(vue, "updateTexture") : undefined;
        if (typeof update === "function") update.call(vue);

        const applied = `Applied ${action} to texture "${texture.name}"`;
        return note ? `${applied}. ${note}` : applied;
      },
    },
    paintToolDocs[10].status
  );
}
