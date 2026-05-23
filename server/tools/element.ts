/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { findElementOrThrow, findTextureOrThrow } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import {
  elementIdSchema,
  vector3Schema,
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
  min_size: vector3Schema
    .optional()
    .describe("Minimum [x,y,z] size for cubes. Cubes smaller on any axis are excluded."),
  max_size: vector3Schema
    .optional()
    .describe("Maximum [x,y,z] size for cubes. Cubes larger on any axis are excluded."),
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

export const addGroupParameters = z.object({
  name: z.string(),
  origin: vector3Schema,
  rotation: vector3Schema,
  parent: z.string().optional().default("root"),
  visibility: z.boolean().optional().default(true),
  autouv: autoUvEnum
    .optional()
    .default("0")
    .describe(
      "Auto UV setting. 0 = disabled, 1 = enabled, 2 = relative auto UV."
    ),
  selected: z.boolean().optional().default(false),
  shade: z.boolean().optional().default(false),
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
  offset: vector3Schema.optional().default([0, 0, 0]),
  newName: z.string().optional(),
});

export const renameElementParameters = z.object({
  id: elementIdSchema.describe("ID or name of the element to rename."),
  new_name: z.string().describe("New name to assign."),
});

export const elementToolDocs: ToolSpec[] = [
  {
    name: "remove_element",
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
    description:
      "Duplicates a cube, mesh or group by ID or name.  You may offset the duplicate or assign a new name.",
    annotations: { title: "Duplicate Element", destructiveHint: true },
    parameters: duplicateElementParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "rename_element",
    description: "Renames a cube, mesh or group by ID or name.",
    annotations: { title: "Rename Element", destructiveHint: true },
    parameters: renameElementParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "find_elements_by_criteria",
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
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      const group = new Group({
        name,
        origin,
        rotation,
        autouv: Number(autouv) as 0 | 1 | 2,
        visibility: Boolean(visibility),
        selected: Boolean(selected),
        shade: Boolean(shade),
      }).init();

      const parentGroup = parent === "root"
        ? "root"
        : // `@ts-expect-error` getAllGroups is a Blockbench global
          getAllGroups().find((g: Group) => g.name === parent || g.uuid === parent);
      group.addTo(parentGroup);

      Undo.finishEdit("Agent added group");
      Canvas.updateAll();

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

      // Helper functions for each type; match patterns used in existing tools:contentReference[oaicite:5]{index=5}.
      function cloneCube(cube: Cube, parent: any) {
        const dupe = new Cube({
          name: newName || `${cube.name}_copy`,
          from: cube.from.map((v, i) => v + offset[i]),
          to: cube.to.map((v, i) => v + offset[i]),
          origin: cube.origin.map((v, i) => v + offset[i]),
          rotation: cube.rotation,
          autouv: cube.autouv,
          uv_offset: cube.uv_offset,
          mirror_uv: cube.mirror_uv,
          shade: cube.shade,
          inflate: cube.inflate,
          color: cube.color,
          visibility: cube.visibility,
        }).init();
        dupe.addTo(parent);
        return dupe;
      }

      function cloneGroup(group: Group, parent: any) {
        const dupeGroup = new Group({
          name: newName || `${group.name}_copy`,
          origin: group.origin.map((v, i) => v + offset[i]),
          rotation: group.rotation,
          autouv: group.autouv,
          selected: group.selected,
          shade: group.shade,
          visibility: group.visibility,
        }).init();
        dupeGroup.addTo(parent);
        group.children.forEach((child: any) => cloneElement(child, dupeGroup));
        return dupeGroup;
      }

      function cloneMesh(mesh: Mesh, parent: any) {
        const dupe = new Mesh({
          name: newName || `${mesh.name}_copy`,
          vertices: {},
          origin: mesh.origin.map((v, i) => v + offset[i]),
          rotation: mesh.rotation,
        }).init();
        const map: Record<string, any> = {};
        Object.entries(mesh.vertices).forEach(([key, coords]: [any, any]) => {
          map[key] = dupe.addVertices([
            coords[0] + offset[0],
            coords[1] + offset[1],
            coords[2] + offset[2],
          ])[0];
        });
        mesh.faces.forEach((face: any) => {
          dupe.addFaces(
            new MeshFace(dupe, {
              vertices: face.vertices.map((v: any) => map[v]),
              uv: face.uv,
            })
          );
        });
        dupe.addTo(parent);
        if ((mesh as any).material) dupe.applyTexture((mesh as any).material);
        return dupe;
      }

      function cloneElement(el: any, parent: any) {
        if (el instanceof Cube) return cloneCube(el, parent);
        if (el instanceof Group) return cloneGroup(el, parent);
        if (el instanceof Mesh) return cloneMesh(el, parent);
        throw new Error("Unsupported element type.");
      }

      Undo.initEdit({ elements: [], outliner: true, collections: [] });
      const dup = cloneElement(element, element.parent ?? Outliner);
      Undo.finishEdit("Agent duplicated element");
      Canvas.updateAll();
      return `Duplicated "${element.name}" as "${dup.name}" (ID: ${dup.uuid}).`;
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
      Undo.initEdit({ elements: [element], outliner: true, collections: [] });
      element.extend({ name: new_name });
      Undo.finishEdit("Agent renamed element");
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
