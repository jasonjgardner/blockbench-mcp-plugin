/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { findElementOrThrow, findTextureOrThrow } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { createGroupWithUndo } from "@/lib/group-creation";
import { runUndoableEdit } from "@/lib/undo";
import { resetClipbenchDuplicateMap } from "@/lib/cube-knife";
import {
  elementIdSchema,
  vector3Schema,
  vec3,
  autoUvEnum,
} from "@/lib/zodObjects";

export const removeElementParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to remove."),
});

export const elementTypeEnum = z.enum(["cube", "mesh", "group", "any"]);

export const findElementsByCriteriaParameters = z.object({
  name_pattern: z
    .string()
    .optional()
    .describe(
      "Regex pattern to match element names (e.g., '^arm_.*'). Case-sensitive."
    ),
  name_contains: z
    .string()
    .optional()
    .describe("Substring to match in element names. Case-insensitive."),
  type: elementTypeEnum
    .optional()
    .default("any")
    .describe("Restrict to a single element type."),
  parent_group: z
    .string()
    .optional()
    .describe(
      "UUID or name of a parent group. Only descendants of this group are returned."
    ),
  min_size: vec3(
    "Minimum [x,y,z] size for cubes. Cubes smaller on any axis are excluded."
  ).optional(),
  max_size: vec3(
    "Maximum [x,y,z] size for cubes. Cubes larger on any axis are excluded."
  ).optional(),
  selected_only: z
    .boolean()
    .optional()
    .default(false)
    .describe("Only consider currently selected elements."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(200)
    .describe("Maximum number of results to return."),
});

export const selectAllOfTypeParameters = z.object({
  type: z
    .enum(["cube", "mesh", "group"])
    .describe("Element type to select."),
  add_to_selection: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, add to current selection. If false, replace selection."),
  parent_group: z
    .string()
    .optional()
    .describe(
      "UUID or name of a parent group. If provided, only descendants of this group are selected."
    ),
});

export const filterByMaterialParameters = z.object({
  texture: z
    .string()
    .describe("Texture ID, UUID or name to search for."),
  include_face_keys: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include the list of cube face keys (e.g., 'north') that reference the texture."
    ),
});

export const getSelectionParameters = z.object({});

/**
 * Parameters for `add_group`, passed to `createGroupWithUndo` as one reversible edit.
 * Expected shape: `name`; optional `origin` pivot and `rotation` (degrees) as
 * `[x, y, z]` defaulting to zeros; `parent` as a group UUID or name, or
 * `"root"` (default) for the project root; plus native group flags
 * `visibility`, `autouv` (`"0"` | `"1"` | `"2"`), `selected`, and `shade`.
 * Parent references are resolved at runtime, so the schema stays free of Blockbench globals.
 */
export const addGroupParameters = z.object({
  name: z.string(),
  origin: vec3("Pivot point of the group as [x, y, z].")
    .optional()
    .default([0, 0, 0]),
  rotation: vec3("Rotation of the group in degrees as [x, y, z].")
    .optional()
    .default([0, 0, 0]),
  parent: z.string().optional().default("root").describe("Parent group UUID or name, or root for the project root."),
  visibility: z.boolean().optional().default(true),
  autouv: autoUvEnum
    .optional()
    .default("0")
    .describe(
      "Auto UV setting. 0 = disabled, 1 = enabled, 2 = relative auto UV."
    ),
  selected: z.boolean().optional().default(false),
  shade: z
    .boolean()
    .optional()
    .default(true)
    .describe("Outliner shading toggle, matching Blockbench's default (true). Ignored by Java 26.3+ projects, which use per-cube shade_direction_override instead."),
});

export const listOutlineParameters = z.object({
  include_cubes: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, include cubes as leaves. If false, return groups only."),
  include_meshes: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, include meshes as leaves. If false, omit meshes."),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .default(32)
    .describe("Maximum tree depth to traverse. Use a small value to summarize large projects."),
});

export const duplicateElementParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to duplicate."),
  offset: vector3Schema
    .optional()
    .default([0, 0, 0])
    .describe("Model-space offset [x, y, z] applied to the copy and every descendant."),
  newName: z
    .string()
    .optional()
    .describe("Name for the top-level copy. Defaults to Blockbench's duplicate naming (trailing number incremented, unique where required)."),
});

export const renameElementParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to rename."),
  new_name: z.string().describe("New name to assign."),
});

export const elementToolDocs: IToolSpec[] = [
  {
    name: "remove_element",
    condition: { project: true, features: ["edit_mode"] },
    description: "Removes the element with the given ID.",
    annotations: {
      title: "Remove Element",
      destructiveHint: true,
    },
    parameters: removeElementParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "add_group",
    condition: { project: true, features: ["edit_mode"] },
    description: "Adds a new group with the given name and options.",
    annotations: {
      title: "Add Group",
      destructiveHint: true,
    },
    parameters: addGroupParameters,
    status: STATUS_STABLE,
  },
  {
    name: "list_outline",
    condition: { project: true },
    description:
      "Returns the project outline as a hierarchical tree. Each node reports { name, uuid, type (cube|mesh|group), children? }. Groups contain child cubes, meshes, and sub-groups. Use `include_cubes=false` to get a group-only skeleton when you just need structure, or `max_depth` to bound very deep trees.",
    annotations: {
      title: "List Outline",
      readOnlyHint: true,
    },
    parameters: listOutlineParameters,
    status: STATUS_STABLE,
  },
  {
    name: "duplicate_element",
    condition: { project: true, features: ["edit_mode"] },
    description:
      "Duplicates any outliner element or group (with its children) by ID or name using Blockbench's native duplicate, so every property, face UV, texture and mesh vertex key is preserved. Mesh copies inherit their armature bone vertex weights. Optionally offsets the copy and assigns a new name. Selection is left unchanged.",
    annotations: { title: "Duplicate Element", destructiveHint: true },
    parameters: duplicateElementParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "rename_element",
    condition: { project: true, features: ["edit_mode"] },
    description: "Renames a cube, mesh or group by ID or name.",
    annotations: { title: "Rename Element", destructiveHint: true },
    parameters: renameElementParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "find_elements_by_criteria",
    condition: { project: true },
    description:
      "Searches the current project for elements matching the given criteria. Supports name pattern matching (regex or substring), type filtering, scoping to a parent group, cube size ranges, and selection scope. Returns element metadata, never modifies state.",
    annotations: {
      title: "Find Elements by Criteria",
      readOnlyHint: true,
    },
    parameters: findElementsByCriteriaParameters,
    status: STATUS_STABLE,
  },
  {
    name: "select_all_of_type",
    condition: { project: true },
    description:
      "Selects all elements of the given type (cube, mesh, or group) in the current project. Optionally restrict to descendants of a parent group, or add to (rather than replace) the current selection.",
    annotations: {
      title: "Select All of Type",
      destructiveHint: true,
    },
    parameters: selectAllOfTypeParameters,
    status: STATUS_STABLE,
  },
  {
    name: "filter_by_material",
    condition: { project: true },
    description:
      "Returns all elements that reference the given texture. For cubes, includes the list of face keys (e.g., 'north', 'up') that use the texture. For meshes, returns the mesh if any face uses the texture.",
    annotations: {
      title: "Filter Elements by Material",
      readOnlyHint: true,
    },
    parameters: filterByMaterialParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_selection",
    condition: { project: true },
    description:
      "Returns the current selection state: selected cube/mesh/group UUIDs and names, plus the active texture. Use this to verify what `apply_texture` or a paint tool with `fill_mode=\"selected_elements\"` will target.",
    annotations: {
      title: "Get Selection",
      readOnlyHint: true,
    },
    parameters: getSelectionParameters,
    status: STATUS_STABLE,
  },
];

interface IElementMatch {
  uuid: string;
  name: string;
  type: "cube" | "mesh" | "group";
  parent: string | null;
}

interface IFilterByMaterialMatch {
  uuid: string;
  name: string;
  type: "cube" | "mesh";
  faces?: string[];
}

function getElementType(el: unknown): "cube" | "mesh" | "group" | null {
  if (el instanceof Cube) return "cube";
  if (el instanceof Mesh) return "mesh";
  if (el instanceof Group) return "group";
  return null;
}

function getParentName(el: { parent?: unknown }): string | null {
  const parent = el.parent as { name?: string; uuid?: string } | undefined;
  if (!parent || typeof parent !== "object") return null;
  return parent.name ?? parent.uuid ?? null;
}

function isDescendantOf(el: { parent?: unknown }, targetGroup: Group): boolean {
  let current: { parent?: unknown } | undefined = el;
  while (current && current.parent && typeof current.parent === "object") {
    if (current.parent === targetGroup) return true;
    current = current.parent as { parent?: unknown };
  }
  return false;
}

function cubeSize(cube: Cube): [number, number, number] {
  return [
    cube.to[0] - cube.from[0],
    cube.to[1] - cube.from[1],
    cube.to[2] - cube.from[2],
  ];
}

function exceedsBounds(
  size: [number, number, number],
  min?: number[],
  max?: number[]
): boolean {
  if (min && size.some((v, i) => v < (min[i] ?? -Infinity))) return true;
  if (max && size.some((v, i) => v > (max[i] ?? Infinity))) return true;
  return false;
}

const MAX_REGEX_PATTERN_LENGTH = 512;
// Heuristic: nested quantifiers like (a+)+, (.*)*, (a+|b)*, (foo){2,}+ are the
// classic catastrophic-backtracking shape. Reject quantifiers applied to a
// group whose body already contains a quantifier.
const CATASTROPHIC_BACKTRACK_HEURISTIC = /\([^)]*[+*?][^)]*\)\s*[+*?{]/;

function safeCompileRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    console.warn(
      `[MCP] find_elements_by_criteria: name_pattern rejected — exceeds ${MAX_REGEX_PATTERN_LENGTH} chars (got ${pattern.length}).`
    );
    return null;
  }
  if (CATASTROPHIC_BACKTRACK_HEURISTIC.test(pattern)) {
    console.warn(
      `[MCP] find_elements_by_criteria: name_pattern rejected — nested quantifiers risk catastrophic backtracking: ${pattern}`
    );
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch (err) {
    console.warn(
      `[MCP] find_elements_by_criteria: name_pattern failed to compile, ignoring filter:`,
      err
    );
    return null;
  }
}

/** Outliner node with the fields duplicate_element reads; Group is no longer an OutlinerElement in 5.2 types. */
type DuplicableNode = OutlinerElement | Group;

/** Structural view of positional arrays and children that most outliner node types expose. */
interface IPositionedNode {
  from?: unknown;
  to?: unknown;
  origin?: unknown;
  position?: unknown;
  children?: unknown;
}

/** Schema vectors are length-validated number arrays; Blockbench expects its tuple type. */
function toVector3(vector: number[]): ArrayVector3 {
  return [vector[0], vector[1], vector[2]];
}

function isVector3(value: unknown): value is ArrayVector3 {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number");
}

function childrenOf(node: unknown): OutlinerNode[] {
  const children = (node as IPositionedNode).children;
  return Array.isArray(children) ? (children as OutlinerNode[]) : [];
}

/**
 * Original/copy pairs for a duplicated subtree. `duplicate()` appends each child
 * copy in the original's child order, so the two trees can be walked in lockstep.
 */
function pairSubtrees(original: OutlinerNode, copy: OutlinerNode): [OutlinerNode, OutlinerNode][] {
  const copyChildren = childrenOf(copy);
  return [
    [original, copy],
    ...childrenOf(original).flatMap((child, index) => (copyChildren[index] ? pairSubtrees(child, copyChildren[index]) : [])),
  ];
}

/**
 * Moves one node by `offset`. Positional arrays are deduplicated by identity
 * because NullObject/Locator/ArmatureBone expose `origin` and `position` as the same array.
 */
function shiftNode(node: OutlinerNode, offset: ArrayVector3): void {
  const positioned = node as IPositionedNode;
  const vectors = [...new Set([positioned.from, positioned.to, positioned.origin, positioned.position].filter(isVector3))];
  vectors.forEach((vector) => {
    vector[0] += offset[0];
    vector[1] += offset[1];
    vector[2] += offset[2];
  });
}

/**
 * Offsets a copied subtree in model space. Cubes, groups, meshes and markers
 * under groups store absolute coordinates, but anything whose parent is an
 * ArmatureBone is positioned relative to that bone and moves with it.
 */
function offsetSubtree(node: OutlinerNode, offset: ArrayVector3, parentIsBone = false): void {
  if (!parentIsBone) shiftNode(node, offset);
  const isBone = typeof ArmatureBone !== "undefined" && node instanceof ArmatureBone;
  childrenOf(node).forEach((child) => offsetSubtree(child, offset, isBone));
}

/** ArmatureBone exists only on Blockbench 5.0+. */
function allArmatureBones(): ArmatureBone[] {
  return typeof ArmatureBone === "undefined" ? [] : ArmatureBone.all;
}

/** Bones that hold any weight for one of `meshes`; snapshotted before the edit so weight copies are undoable. */
function bonesWeightingMeshes(meshes: Mesh[]): ArmatureBone[] {
  return allArmatureBones().filter((bone) =>
    meshes.some((mesh) => Object.keys(mesh.vertices).some((vkey) => bone.getVertexWeight(mesh, vkey) > 0)));
}

/**
 * Copies vertex weights from each original mesh to its copy, as Blockbench 5.2's
 * native Duplicate does. Weights land on the copied bone when the bone was
 * duplicated alongside the mesh, otherwise on the original bone. Vertex keys are
 * preserved by `Mesh.duplicate()`, so keys map one-to-one.
 */
function copyVertexWeights(pairs: [OutlinerNode, OutlinerNode][], bones: ArmatureBone[]): void {
  const boneCopies = new Map(pairs.filter(([original]) => original instanceof ArmatureBone) as [ArmatureBone, ArmatureBone][]);
  const meshPairs = pairs.filter(([original]) => original instanceof Mesh) as [Mesh, Mesh][];
  meshPairs.forEach(([original, copy]) => bones.forEach((bone) => {
    const target = boneCopies.get(bone) ?? bone;
    Object.keys(original.vertices).forEach((vkey) => {
      const weight = bone.getVertexWeight(original, vkey);
      if (weight > 0) target.setVertexWeight(copy, vkey, weight);
    });
  }));
}

/**
 * Duplicates `node` (and its subtree) with Blockbench's own `duplicate()` in one
 * undoable edit, then offsets, renames, and carries mesh vertex weights over.
 * The live selection is restored afterwards, and `Clipbench.duplicate_map` is
 * reset because only the native Duplicate action clears it.
 *
 * @param node - Element or group to copy.
 * @param offset - Model-space translation for the copy.
 * @param name - Optional name for the top-level copy.
 * @returns The top-level copy.
 */
function duplicateNode(node: DuplicableNode, offset: ArrayVector3, name: string | undefined): DuplicableNode {
  const originals = [node, ...pairSubtrees(node, node).slice(1).map(([original]) => original)];
  const bones = bonesWeightingMeshes(originals.filter((candidate): candidate is Mesh => candidate instanceof Mesh));
  const elements: OutlinerElement[] = [...bones];
  const selected = [...Outliner.selected];
  try {
    return runUndoableEdit({ elements, outliner: true }, "Agent duplicated element", () => {
      const copy = (node as unknown as { duplicate(): DuplicableNode }).duplicate();
      const pairs = pairSubtrees(node, copy);
      elements.push(...pairs.map(([, created]) => created).filter((created): created is OutlinerElement => created instanceof OutlinerElement));
      if (offset.some((value) => value !== 0)) offsetSubtree(copy, offset);
      if (name !== undefined) copy.name = name;
      copyVertexWeights(pairs, bones);
      return copy;
    });
  } finally {
    resetClipbenchDuplicateMap();
    Outliner.selected.splice(0, Outliner.selected.length, ...selected);
  }
}

export function registerElementTools() {
  createTool(elementToolDocs[0].name, {
    ...elementToolDocs[0],
    async execute({ id }) {
      const element = findElementOrThrow(id);

      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      element.remove();

      Undo.finishEdit("Agent removed element");
      Canvas.updateAll();

      return `Removed element with ID ${id}`;
    },
  }, elementToolDocs[0].status);

  createTool(elementToolDocs[1].name, {
    ...elementToolDocs[1],
    async execute({
      name,
      origin,
      rotation,
      parent,
      visibility,
      autouv,
      selected,
      shade,
    }) {
      const group = createGroupWithUndo({
        name,
        origin,
        rotation,
        autouv: Number(autouv) as 0 | 1 | 2,
        visibility: Boolean(visibility),
        selected: Boolean(selected),
        shade: Boolean(shade),
      }, parent);

      return `Added group ${group.name} with ID ${group.uuid}`;
    },
  }, elementToolDocs[1].status);

  createTool(elementToolDocs[2].name, {
    ...elementToolDocs[2],
    async execute({ include_cubes, include_meshes, max_depth }) {
      interface IOutlineNode {
        name: string;
        uuid: string;
        type: "cube" | "mesh" | "group";
        children?: IOutlineNode[];
      }

      const truncated: string[] = [];

      const nodeFor = (el: unknown, depth: number): IOutlineNode | null => {
        if (el instanceof Group) {
          const node: IOutlineNode = {
            name: el.name,
            uuid: el.uuid,
            type: "group",
            children: [],
          };
          if (depth >= max_depth) {
            truncated.push(el.name);
            delete node.children;
            return node;
          }
          for (const child of el.children ?? []) {
            const childNode = nodeFor(child, depth + 1);
            if (childNode) node.children!.push(childNode);
          }
          return node;
        }
        if (el instanceof Cube) {
          if (!include_cubes) return null;
          return { name: el.name, uuid: el.uuid, type: "cube" };
        }
        if (el instanceof Mesh) {
          if (!include_meshes) return null;
          return { name: el.name, uuid: el.uuid, type: "mesh" };
        }
        return null;
      };

      const roots = Outliner.root
        .map((el) => nodeFor(el, 0))
        .filter((n): n is IOutlineNode => n !== null);

      const counts = {
        groups: Group.all.length,
        cubes: Cube.all.length,
        meshes: Mesh.all.length,
      };

      return JSON.stringify(
        {
          counts,
          truncated_at_max_depth: truncated.length ? truncated : undefined,
          roots,
        },
        null,
        2
      );
    },
  }, elementToolDocs[2].status);

  createTool(elementToolDocs[3].name, {
    ...elementToolDocs[3],
    async execute({ id, offset, newName }) {
      const element = findElementOrThrow(id);
      const copy = duplicateNode(element, toVector3(offset), newName);
      Canvas.updateAll();
      return `Duplicated "${element.name}" as "${copy.name}" (ID: ${copy.uuid}).`;
    },
  }, elementToolDocs[3].status);

  /**
   * Rename an element.  Mirrors the simple property change seen in the existing tools,
   * using `extend` to apply the change and updating the editor.
   */
  createTool(elementToolDocs[4].name, {
    ...elementToolDocs[4],
    async execute({ id, new_name }) {
      const element = findElementOrThrow(id);
      // 5.2 types split Group from OutlinerElement; groups are snapshotted through the groups aspect.
      const aspects: UndoAspects = element instanceof Group
        ? { groups: [element], outliner: true }
        : { elements: [element], outliner: true, collections: [] };
      runUndoableEdit(aspects, "Agent renamed element", () => {
        // Both types implement extend(), which sanitizes the name; the published union does not guarantee it.
        (element as unknown as { extend(data: { name: string }): unknown }).extend({ name: new_name });
      });
      Canvas.updateAll();
      return `Renamed element "${id}" to "${new_name}".`;
    },
  }, elementToolDocs[4].status);

  createTool(elementToolDocs[5].name, {
    ...elementToolDocs[5],
    async execute({
      name_pattern,
      name_contains,
      type,
      parent_group,
      min_size,
      max_size,
      selected_only,
      limit,
    }) {
      const regex = safeCompileRegex(name_pattern);
      const needle = name_contains?.toLowerCase() ?? null;
      const parentScope = parent_group
        // @ts-ignore - Group is a Blockbench global
        ? (Group.all.find((g: Group) => g.uuid === parent_group || g.name === parent_group) ?? null)
        : null;

      if (parent_group && !parentScope) {
        throw new Error(
          `Parent group "${parent_group}" not found. Use list_outline to see available groups.`
        );
      }

      const candidates: Array<Cube | Mesh | Group> = [
        ...(selected_only ? Cube.selected : Cube.all),
        ...(selected_only ? Mesh.selected : Mesh.all),
        ...(selected_only ? Group.all.filter((g: Group) => g.selected) : Group.all),
      ];

      const matches: IElementMatch[] = [];

      for (const el of candidates) {
        if (matches.length >= limit) break;

        const elType = getElementType(el);
        if (!elType) continue;
        if (type !== "any" && elType !== type) continue;
        if (regex && !regex.test(el.name)) continue;
        if (needle && !el.name.toLowerCase().includes(needle)) continue;
        if (parentScope && !isDescendantOf(el, parentScope)) continue;

        if (el instanceof Cube && (min_size || max_size)) {
          if (exceedsBounds(cubeSize(el), min_size, max_size)) continue;
        }

        matches.push({
          uuid: el.uuid,
          name: el.name,
          type: elType,
          parent: getParentName(el),
        });
      }

      return JSON.stringify(
        {
          count: matches.length,
          truncated: matches.length >= limit,
          matches,
        },
        null,
        2
      );
    },
  }, elementToolDocs[5].status);

  createTool(elementToolDocs[6].name, {
    ...elementToolDocs[6],
    async execute({ type, add_to_selection, parent_group }) {
      const parentScope = parent_group
        // @ts-ignore - Group is a Blockbench global
        ? (Group.all.find((g: Group) => g.uuid === parent_group || g.name === parent_group) ?? null)
        : null;

      if (parent_group && !parentScope) {
        throw new Error(
          `Parent group "${parent_group}" not found. Use list_outline to see available groups.`
        );
      }

      const pool: Array<Cube | Mesh | Group> = (() => {
        if (type === "cube") return [...Cube.all];
        if (type === "mesh") return [...Mesh.all];
        return [...Group.all];
      })();

      const targets = parentScope
        ? pool.filter((el) => isDescendantOf(el, parentScope))
        : pool;

      if (!add_to_selection) {
        // @ts-ignore - selected method available on element classes
        Cube.all.forEach((c: Cube) => c.selected && c.unselect?.());
        // @ts-ignore - selected method available on element classes
        Mesh.all.forEach((m: Mesh) => m.selected && m.unselect?.());
        Group.all.forEach((g: Group) => {
          if (g.selected) g.selected = false;
        });
      }

      for (const el of targets) {
        if (el instanceof Group) {
          el.selected = true;
          continue;
        }
        // @ts-ignore - select method available on outliner elements
        el.select?.({ shiftKey: true });
      }

      updateSelection();
      Canvas.updateAll();

      return JSON.stringify(
        {
          type,
          selected: targets.length,
          parent_group: parentScope?.name ?? null,
        },
        null,
        2
      );
    },
  }, elementToolDocs[6].status);

  createTool(elementToolDocs[7].name, {
    ...elementToolDocs[7],
    async execute({ texture, include_face_keys }) {
      const tex = findTextureOrThrow(texture);
      const matches: IFilterByMaterialMatch[] = [];

      for (const cube of Cube.all) {
        const faceKeys: string[] = [];
        for (const [key, face] of Object.entries(cube.faces ?? {})) {
          const faceTexId = (face as { texture?: unknown }).texture;
          if (faceTexId === tex.uuid || faceTexId === tex.id) {
            faceKeys.push(key);
          }
        }
        if (faceKeys.length > 0) {
          matches.push({
            uuid: cube.uuid,
            name: cube.name,
            type: "cube",
            ...(include_face_keys ? { faces: faceKeys } : {}),
          });
        }
      }

      for (const mesh of Mesh.all) {
        const faceKeys: string[] = [];
        for (const [key, face] of Object.entries(mesh.faces ?? {})) {
          const faceTexId = (face as { texture?: unknown }).texture;
          if (faceTexId === tex.uuid || faceTexId === tex.id) {
            faceKeys.push(key);
          }
        }
        if (faceKeys.length > 0) {
          matches.push({
            uuid: mesh.uuid,
            name: mesh.name,
            type: "mesh",
            ...(include_face_keys ? { faces: faceKeys } : {}),
          });
        }
      }

      return JSON.stringify(
        {
          texture: { uuid: tex.uuid, name: tex.name },
          count: matches.length,
          matches,
        },
        null,
        2
      );
    },
  }, elementToolDocs[7].status);

  createTool(elementToolDocs[8].name, {
    ...elementToolDocs[8],
    async execute() {
      const cubes = Cube.selected.map((c: Cube) => ({
        uuid: c.uuid,
        name: c.name,
        type: "cube" as const,
      }));
      const meshes = Mesh.selected.map((m: Mesh) => ({
        uuid: m.uuid,
        name: m.name,
        type: "mesh" as const,
      }));
      const groups = Group.all
        .filter((g: Group) => g.selected)
        .map((g: Group) => ({
          uuid: g.uuid,
          name: g.name,
          type: "group" as const,
        }));

      const activeTexture = Texture.selected
        ? {
            uuid: Texture.selected.uuid,
            id: Texture.selected.id,
            name: Texture.selected.name,
            width: Texture.selected.width,
            height: Texture.selected.height,
          }
        : null;

      return JSON.stringify(
        {
          counts: {
            cubes: cubes.length,
            meshes: meshes.length,
            groups: groups.length,
          },
          cubes,
          meshes,
          groups,
          active_texture: activeTexture,
        },
        null,
        2
      );
    },
  }, elementToolDocs[8].status);
}
