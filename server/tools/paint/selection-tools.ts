/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { getAndActivateTexture } from "@/lib/util";
import { runUndoableEdit } from "@/lib/undo";
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

/** Grows (or, with `grow` false, shrinks) the selection by a round brush of `radius` pixels. */
function morph(before: boolean[], width: number, height: number, radius: number, grow: boolean): boolean[] {
  const r = Math.max(1, Math.round(radius));
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  }
  return before.map((_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    // Outside the texture counts as selected when shrinking, so edges do not erode.
    const at = (px: number, py: number): boolean =>
      px < 0 || py < 0 || px >= width || py >= height ? !grow : before[py * width + px];
    return grow ? offsets.some(([dx, dy]) => at(x + dx, y + dy)) : offsets.every(([dx, dy]) => at(x + dx, y + dy));
  });
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
 * action to a texture's pixel selection inside an undo entry.
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

        runUndoableEdit({ textures: [texture], bitmap: true }, "Texture selection", () => {
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
            after = morph(before, width, height, radius ?? 1, action === "expand_selection");
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

        return `Applied ${action} to texture "${texture.name}"`;
      },
    },
    paintToolDocs[10].status
  );
}
