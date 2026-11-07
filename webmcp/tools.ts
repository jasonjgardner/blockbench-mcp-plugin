/// <reference types="three" />
/// <reference types="blockbench-types" />
/// <reference types="webmcp-types" />

import { createGroupWithUndo } from "@/lib/group-creation";
import {
  addCylinderGeometry,
  addNewMesh,
  addSphereGeometry,
  createMeshEdit,
} from "@/lib/mesh-primitives";
import { runUndoableEdit } from "@/lib/undo";
import {
  findElementOrThrow,
  findGroupOrThrow,
  getAndActivateTexture,
  getProjectTexture,
} from "@/lib/util";
import { pbrChannelEnum } from "@/lib/zodObjects";
import { applyKeyframeValues, requireBoneAnimator } from "@/server/tools/animation/shared";
import { addCreatedTexture, loadTextureData } from "@/server/tools/texture/create-texture";
import { commitMaterialEdit, type ITextureChange } from "@/server/tools/texture/material-edit";
import schemaJson from "@/webmcp/schema.json";
import {
  paginateWebMcpItems,
  WebMcpActionableError,
  WEBMCP_DEFAULT_PAGE_SIZE,
  WEBMCP_MAX_OUTPUT_CHARS,
  type IWebMcpInputSchema,
  type IWebMcpToolDefinition,
} from "@/webmcp/runtime";

/** Default and ceiling for `export_project_model` compile slices; kept in sync with `schema.json`. */
const EXPORT_DEFAULT_LIMIT = 800;
const EXPORT_MAX_LIMIT = 1000;
const EXPORT_MIN_LIMIT = 100;

/** Lookup helper to pull the canonical JSON Schema and metadata from `webmcp/schema.json`. */
function getSchemaEntry(name: string): {
  name: string;
  description: string;
  inputSchema: IWebMcpInputSchema;
  annotations?: WebMCP.ToolAnnotations;
} {
  const match = schemaJson.tools.find(entry => entry.name === name);
  if (!match) {
    throw new Error(`Missing schema.json entry for WebMCP tool "${name}".`);
  }
  return {
    name: match.name,
    description: match.description,
    inputSchema: match.inputSchema as unknown as IWebMcpInputSchema,
    ...(match.annotations ? { annotations: match.annotations as WebMCP.ToolAnnotations } : {}),
  };
}

/** Ensures an active Blockbench project exists or throws an actionable WebMCP error. */
function requireActiveProject(): ModelProject {
  if (typeof Project === "undefined" || !Project) {
    throw new WebMcpActionableError(
      "No project is currently open in Blockbench.",
      "NO_ACTIVE_PROJECT",
      true,
      "Call create_project to start a new model, or ask the user to open a .bbmodel file.",
    );
  }
  return Project;
}

/** Returns the current active workspace mode ID (`edit`, `paint`, `animate`, `display`, etc.). */
function getActiveModeId(): string | null {
  if (typeof Modes === "undefined" || !Modes?.selected) return null;
  const selected = Modes.selected as { id?: string };
  return selected.id ?? null;
}

/** Cube specification accepted by `mutate_outliner_items` (`create_cubes`). */
interface ICubeSpec {
  name: string;
  from: [number, number, number];
  to: [number, number, number];
  origin?: [number, number, number];
  rotation?: [number, number, number];
}

/** Keyframe specification accepted by `manage_animations` (`set_keyframes`). */
interface IKeyframeSpec {
  time: number;
  values: [number, number, number];
  interpolation?: "linear" | "catmullrom" | "bezier" | "step";
}

/**
 * Execute handler for `get_project_summary` (Goal 1).
 */
async function executeGetProjectSummary(args: Record<string, unknown>): Promise<unknown> {
  const includeFormats = Boolean(args.include_formats);
  const availableFormats = typeof Formats !== "undefined" && Formats
    ? Object.keys(Formats).toSorted()
    : [];

  if (typeof Project === "undefined" || !Project) {
    return {
      status: "no_project",
      active_mode: getActiveModeId(),
      ...(includeFormats ? { available_formats: availableFormats.slice(0, 20) } : {}),
    };
  }

  const format = (typeof Format !== "undefined" ? Format : undefined) as
    | { id?: string; name?: string; display_name?: string; bone_rig?: boolean; meshes?: boolean; animation_mode?: boolean }
    | undefined;

  const rootGroups = (Outliner?.root ?? [])
    .filter((node): node is Group => typeof Group !== "undefined" && node instanceof Group)
    .slice(0, 12)
    .map(group => ({
      id: group.uuid,
      name: group.name,
      children_count: group.children?.length ?? 0,
    }));

  return {
    status: "open",
    project: {
      name: Project.name || "unnamed",
      uuid: Project.uuid,
      unsaved_changes: Project.saved === false,
    },
    format: {
      id: format?.id ?? null,
      name: format?.display_name ?? format?.name ?? null,
      supports_bones: Boolean(format?.bone_rig),
      supports_meshes: Boolean(format?.meshes),
      supports_animation: Boolean(format?.animation_mode),
    },
    active_mode: getActiveModeId(),
    resolution: {
      width: Project.texture_width ?? 16,
      height: Project.texture_height ?? 16,
    },
    counts: {
      cubes: typeof Cube !== "undefined" ? Cube.all.length : 0,
      meshes: typeof Mesh !== "undefined" ? Mesh.all.length : 0,
      groups: typeof Group !== "undefined" ? Group.all.length : 0,
      textures: typeof Texture !== "undefined" ? Texture.all.length : 0,
    },
    root_groups: rootGroups,
    ...(includeFormats ? { available_formats: availableFormats.slice(0, 24), formats_total: availableFormats.length } : {}),
  };
}

/**
 * Execute handler for `create_project` (Goal 1).
 * Blockbench's `newProject()` opens the new model in its own tab and leaves the previously
 * active project (saved or not) open, so no unsaved-work guard or confirmation is needed.
 */
async function executeCreateProject(args: Record<string, unknown>): Promise<unknown> {
  const projectName = String(args.project_name ?? "").trim();
  const formatId = String(args.format_id ?? "bedrock_block").trim();
  const previousProject = typeof Project !== "undefined" && Project ? Project.name || "unnamed" : null;

  if (!projectName) {
    throw new WebMcpActionableError(
      "Parameter 'project_name' is required and cannot be empty.",
      "MISSING_PARAMETER",
      true,
      "Ask the user what they want to name the new project.",
    );
  }

  if (typeof Formats === "undefined" || !Object.hasOwn(Formats, formatId)) {
    const validIds = typeof Formats !== "undefined" ? Object.keys(Formats).toSorted().join(", ") : "none";
    throw new WebMcpActionableError(
      `Unknown model format "${formatId}". Valid formats: ${validIds}.`,
      "INVALID_FORMAT",
      true,
      "Call get_project_summary with include_formats=true or choose a valid format_id.",
    );
  }

  const created = newProject(Formats[formatId]);
  if (!created || typeof Project === "undefined" || !Project) {
    throw new WebMcpActionableError(
      `Blockbench could not initialize a project for format "${formatId}".`,
      "PROJECT_CREATION_FAILED",
      false,
    );
  }

  Project.name = projectName;
  return {
    status: "created",
    project_name: Project.name,
    uuid: Project.uuid,
    format_id: formatId,
    resolution: {
      width: Project.texture_width ?? 16,
      height: Project.texture_height ?? 16,
    },
    ...(previousProject ? { previous_project_still_open: previousProject } : {}),
  };
}

/**
 * Execute handler for `list_outliner_items` (Goal 1).
 * Consolidates cube, mesh, and bone group discovery with pagination and facet summaries.
 */
async function executeListOutlinerItems(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const requestedTypes = Array.isArray(args.types)
    ? new Set(args.types.map(String))
    : new Set(["cube", "mesh", "group"]);
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const parentFilter = typeof args.parent_group === "string" ? args.parent_group.trim() : "";
  const selectedOnly = Boolean(args.selected_only);
  const page = typeof args.page === "number" ? args.page : 1;
  const pageSize = typeof args.page_size === "number" ? args.page_size : WEBMCP_DEFAULT_PAGE_SIZE;

  const parentGroup = parentFilter && parentFilter !== "root"
    ? findGroupOrThrow(parentFilter)
    : null;

  const rawGroups = typeof Group !== "undefined" ? Group.all : [];
  const rawElements = typeof Outliner !== "undefined" ? Outliner.elements : [];

  const allEntries = [
    ...rawGroups.map(group => ({
      id: group.uuid,
      name: group.name,
      type: "group" as const,
      parent: group.parent instanceof Group ? group.parent.name : "root",
      // `selected` is emitted only when true so a default page of 10 rows stays inside the output budget.
      ...(group.selected ? { selected: true } : {}),
      isDescendant: parentGroup ? group.isChildOf(parentGroup, Infinity) : true,
    })),
    ...rawElements.map(element => {
      const elType = element.type === "mesh" ? ("mesh" as const) : ("cube" as const);
      const parentNode = (element as { parent?: unknown }).parent;
      return {
        id: element.uuid,
        name: element.name,
        type: elType,
        parent: typeof Group !== "undefined" && parentNode instanceof Group ? parentNode.name : "root",
        ...(Array.isArray(Outliner.selected) && Outliner.selected.includes(element) ? { selected: true } : {}),
        isDescendant: parentGroup
          ? typeof (element as { isChildOf?: (g: Group, d: number) => boolean }).isChildOf === "function" &&
            (element as { isChildOf: (g: Group, d: number) => boolean }).isChildOf(parentGroup, Infinity)
          : true,
      };
    }),
  ];

  const facetCounts = {
    cube: allEntries.filter(item => item.type === "cube").length,
    mesh: allEntries.filter(item => item.type === "mesh").length,
    group: allEntries.filter(item => item.type === "group").length,
  };

  const filtered = allEntries
    .filter(item => requestedTypes.has(item.type))
    .filter(item => item.isDescendant)
    .filter(item => !selectedOnly || item.selected === true)
    .filter(item => !query || item.name.toLowerCase().includes(query))
    .map(({ isDescendant: _ignored, ...rest }) => rest);

  if (filtered.length === 0 && (query || parentFilter || selectedOnly)) {
    return {
      ...paginateWebMcpItems([], 1, pageSize, { types: facetCounts }),
      relaxation_hint: "No outliner items matched all filters. Try clearing 'query', 'selected_only', or 'parent_group'.",
    };
  }

  return paginateWebMcpItems(filtered, page, pageSize, { types: facetCounts });
}

/**
 * Execute handler for `mutate_outliner_items` (Goal 1).
 * Reuses `runUndoableEdit`, `createGroupWithUndo`, `createMeshEdit`, `addNewMesh`,
 * `addSphereGeometry`, `addCylinderGeometry`, and `findElementOrThrow` from `@/lib`.
 */
async function executeMutateOutlinerItems(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const operation = String(args.operation ?? "");
  const parentRef = typeof args.parent_group === "string" && args.parent_group.trim().length > 0
    ? args.parent_group.trim()
    : "root";

  if (operation === "create_group") {
    const groupName = typeof args.group_name === "string" && args.group_name.trim().length > 0
      ? args.group_name.trim()
      : "bone";
    const rotation = Array.isArray(args.rotation) && args.rotation.length === 3
      ? (args.rotation.map(Number) as [number, number, number])
      : ([0, 0, 0] as [number, number, number]);
    const childRefs = Array.isArray(args.target_ids) ? args.target_ids.map(String) : [];
    const createdGroup = createGroupWithUndo(
      { name: groupName, rotation },
      parentRef,
      childRefs,
      undefined,
      `WebMCP: Create group ${groupName}`,
    );
    return {
      status: "created_group",
      id: createdGroup.uuid,
      name: createdGroup.name,
      parent: parentRef,
      children_moved: childRefs.length,
    };
  }

  if (operation === "create_cubes") {
    const cubeSpecs = Array.isArray(args.cubes) ? (args.cubes as ICubeSpec[]) : [];
    if (cubeSpecs.length === 0) {
      throw new WebMcpActionableError(
        "Operation 'create_cubes' requires a non-empty 'cubes' array.",
        "MISSING_PARAMETER",
        true,
        "Provide at least one cube with 'name', 'from', and 'to' coordinates.",
      );
    }
    const targetParent = parentRef === "root" ? "root" : findGroupOrThrow(parentRef);
    const defaultTexture = typeof Texture !== "undefined" ? Texture.getDefault?.() ?? null : null;
    const createdElements: Cube[] = [];

    const summaries = runUndoableEdit(
      { elements: createdElements, outliner: true },
      `WebMCP: Create ${cubeSpecs.length} cube(s)`,
      () =>
        cubeSpecs.map(spec => {
          const cube = new Cube({
            name: spec.name,
            from: spec.from,
            to: spec.to,
            ...(spec.origin ? { origin: spec.origin } : {}),
            ...(spec.rotation ? { rotation: spec.rotation } : {}),
          }).init();
          createdElements.push(cube);
          cube.addTo(targetParent);
          if (defaultTexture) {
            cube.applyTexture(defaultTexture, true);
          }
          return { id: cube.uuid, name: cube.name, from: spec.from, to: spec.to };
        }),
    );

    return {
      status: "created_cubes",
      count: summaries.length,
      parent: parentRef,
      created: summaries.slice(0, 12),
    };
  }

  if (operation === "create_sphere" || operation === "create_cylinder") {
    const primitive = (args.primitive ?? {}) as {
      position?: number[];
      diameter?: number;
      height?: number;
      sides?: number;
    };
    const meshName = typeof args.group_name === "string" && args.group_name.trim()
      ? args.group_name.trim()
      : operation === "create_sphere" ? "sphere" : "cylinder";
    const position = Array.isArray(primitive.position) && primitive.position.length === 3
      ? primitive.position.map(Number)
      : [0, 0, 0];
    const diameter = Number(primitive.diameter ?? 8);
    const height = Number(primitive.height ?? 8);
    const sides = Math.min(64, Math.max(3, Math.trunc(Number(primitive.sides ?? 12))));
    const outlinerGroup = parentRef === "root" ? "root" : findGroupOrThrow(parentRef);
    const projectTexture = typeof Texture !== "undefined" ? Texture.getDefault?.() ?? null : null;

    const createdMesh = createMeshEdit(`WebMCP: Create ${operation}`, meshes => {
      const [mesh] = addNewMesh(
        meshes,
        { name: meshName, position },
        { projectTexture, outlinerGroup },
        targetMesh => {
          if (operation === "create_sphere") {
            addSphereGeometry(targetMesh, { diameter, sides, align_edges: true });
            return;
          }
          addCylinderGeometry(targetMesh, { diameter, height, sides, capped: true });
        },
      );
      return {
        id: mesh.uuid,
        name: mesh.name,
        vertices: Object.keys(mesh.vertices).length,
        faces: Object.keys(mesh.faces).length,
      };
    });

    return {
      status: "created_mesh",
      primitive_type: operation === "create_sphere" ? "sphere" : "cylinder",
      mesh: createdMesh,
    };
  }

  const targetIds = Array.isArray(args.target_ids) ? args.target_ids.map(String) : [];
  if (targetIds.length === 0) {
    throw new WebMcpActionableError(
      `Operation "${operation}" requires 'target_ids' with at least one element or group ID/name.`,
      "MISSING_PARAMETER",
      true,
      "Call list_outliner_items first to get target IDs, then pass them in target_ids.",
    );
  }

  const resolvedNodes = targetIds.map(id => findElementOrThrow(id));
  const elements = resolvedNodes.filter((n): n is OutlinerElement => !(typeof Group !== "undefined" && n instanceof Group));
  const groups = resolvedNodes.filter((n): n is Group => typeof Group !== "undefined" && n instanceof Group);

  if (operation === "transform") {
    const offset = Array.isArray(args.offset) && args.offset.length === 3
      ? args.offset.map(Number)
      : [0, 0, 0];
    const rotation = Array.isArray(args.rotation) && args.rotation.length === 3
      ? args.rotation.map(Number)
      : null;

    runUndoableEdit(
      { elements, groups, outliner: true },
      `WebMCP: Transform ${resolvedNodes.length} node(s)`,
      () => {
        resolvedNodes.forEach(node => {
          const maybeCube = node as { from?: number[]; to?: number[]; origin?: number[]; rotation?: number[] };
          if (Array.isArray(maybeCube.from) && Array.isArray(maybeCube.to)) {
            maybeCube.from = [
              maybeCube.from[0] + offset[0],
              maybeCube.from[1] + offset[1],
              maybeCube.from[2] + offset[2],
            ];
            maybeCube.to = [
              maybeCube.to[0] + offset[0],
              maybeCube.to[1] + offset[1],
              maybeCube.to[2] + offset[2],
            ];
          }
          if (Array.isArray(maybeCube.origin)) {
            maybeCube.origin = [
              maybeCube.origin[0] + offset[0],
              maybeCube.origin[1] + offset[1],
              maybeCube.origin[2] + offset[2],
            ];
          }
          if (rotation && Array.isArray(maybeCube.rotation)) {
            maybeCube.rotation = [rotation[0], rotation[1], rotation[2]];
          }
        });
      },
    );

    return {
      status: "transformed",
      updated_count: resolvedNodes.length,
      target_ids: resolvedNodes.map(n => n.uuid),
      offset,
      ...(rotation ? { rotation } : {}),
    };
  }

  if (operation === "remove") {
    const removedIds = resolvedNodes.map(n => ({ id: n.uuid, name: n.name }));
    runUndoableEdit(
      { elements, groups, outliner: true },
      `WebMCP: Remove ${resolvedNodes.length} node(s)`,
      () => {
        resolvedNodes.forEach(node => {
          node.remove();
        });
      },
      { elements: [], groups: [], outliner: true },
    );
    return {
      status: "removed",
      removed_count: removedIds.length,
      removed: removedIds.slice(0, 12),
    };
  }

  throw new WebMcpActionableError(
    `Unsupported outliner operation "${operation}".`,
    "INVALID_OPERATION",
    true,
    "Choose one of: create_cubes, create_group, create_sphere, create_cylinder, transform, remove.",
  );
}

/**
 * Execute handler for `manage_history` (Goal 1).
 */
async function executeManageHistory(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const action = String(args.action ?? "list");
  const steps = Math.min(50, Math.max(1, Math.trunc(Number(args.steps ?? 1))));

  if (action === "undo") {
    if (Undo.index <= 0) {
      throw new WebMcpActionableError(
        "Nothing to undo: the undo stack is at its earliest state.",
        "EMPTY_UNDO_STACK",
        false,
      );
    }
    const appliedSteps = Math.min(steps, Undo.index);
    for (let i = 0; i < appliedSteps; i++) {
      Undo.undo();
    }
    return {
      status: "undone",
      steps_undone: appliedSteps,
      current_index: Undo.index,
      total_entries: Undo.history.length,
    };
  }

  if (action === "redo") {
    if (Undo.index >= Undo.history.length) {
      throw new WebMcpActionableError(
        "Nothing to redo: no undone edits remain ahead of the current state.",
        "EMPTY_REDO_STACK",
        false,
      );
    }
    const appliedSteps = Math.min(steps, Undo.history.length - Undo.index);
    for (let i = 0; i < appliedSteps; i++) {
      Undo.redo();
    }
    return {
      status: "redone",
      steps_redone: appliedSteps,
      current_index: Undo.index,
      total_entries: Undo.history.length,
    };
  }

  if (action === "checkpoint") {
    const checkpointName = String(args.checkpoint_name ?? "").trim();
    if (!checkpointName) {
      throw new WebMcpActionableError(
        "Action 'checkpoint' requires a non-empty 'checkpoint_name'.",
        "MISSING_PARAMETER",
        true,
        "Pass checkpoint_name (e.g. 'before_arm_extrude') to label the undo marker.",
      );
    }
    Undo.initEdit({});
    Undo.finishEdit(`[Checkpoint] ${checkpointName}`);
    return {
      status: "checkpoint_saved",
      checkpoint_name: checkpointName,
      index: Undo.index,
    };
  }

  const page = typeof args.page === "number" ? args.page : 1;
  const entries = (Undo.history ?? []).map((entry, idx) => ({
    index: idx + 1,
    action: (entry as { action?: string }).action ?? "Edit",
    applied: idx < Undo.index,
  })).toReversed();

  return paginateWebMcpItems(entries, page, WEBMCP_DEFAULT_PAGE_SIZE, {
    current_index: Undo.index,
    can_undo: Undo.index > 0,
    can_redo: Undo.index < Undo.history.length,
  });
}

/**
 * Execute handler for `list_textures` (Goal 2).
 */
async function executeListTextures(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const channelFilter = typeof args.channel_filter === "string" ? args.channel_filter : "";
  const page = typeof args.page === "number" ? args.page : 1;
  const pageSize = typeof args.page_size === "number" ? args.page_size : WEBMCP_DEFAULT_PAGE_SIZE;

  const allTextures = (typeof Texture !== "undefined" ? Texture.all : []).map(tex => ({
    id: tex.uuid,
    name: tex.name,
    width: tex.width ?? Project?.texture_width ?? 16,
    height: tex.height ?? Project?.texture_height ?? 16,
    pbr_channel: (tex as { pbr_channel?: string }).pbr_channel ?? "color",
    selected: Texture.selected === tex,
  }));

  const filtered = channelFilter
    ? allTextures.filter(tex => tex.pbr_channel === channelFilter)
    : allTextures;

  const materials = typeof TextureGroup !== "undefined" && Array.isArray(TextureGroup.all)
    ? TextureGroup.all.slice(0, 8).map(group => ({
        id: group.uuid,
        name: group.name,
        is_material: Boolean(group.is_material),
      }))
    : [];

  return paginateWebMcpItems(filtered, page, pageSize, {
    material_groups: materials,
  });
}

/**
 * Execute handler for `manage_textures` (Goal 2).
 * Reuses the main plugin's texture pipeline (`loadTextureData`, `addCreatedTexture`,
 * `commitMaterialEdit`) so textures decode, undo, and material previews behave exactly
 * like the HTTP MCP tools.
 */
async function executeManageTextures(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const operation = String(args.operation ?? "");
  const textureRef = typeof args.texture_ref === "string" ? args.texture_ref.trim() : "";

  if (operation === "create_texture") {
    const name = textureRef || "texture";
    const width = Math.min(4096, Math.max(16, Math.trunc(Number(args.width ?? 16))));
    const height = Math.min(4096, Math.max(16, Math.trunc(Number(args.height ?? 16))));
    const fillColor = typeof args.fill_color === "string" && args.fill_color.trim() ? args.fill_color.trim() : "#ffffff";

    const blank = new Texture({ name, width, height, internal: true });
    const texture = await loadTextureData(blank, undefined, fillColor, "color");
    texture.name = name;
    addCreatedTexture(texture, undefined);

    return {
      status: "created",
      texture_id: texture.uuid,
      name: texture.name,
      width,
      height,
      fill_color: fillColor,
    };
  }

  if (operation === "paint_fill") {
    const fillColor = typeof args.fill_color === "string" ? args.fill_color.trim() : "";
    if (!fillColor) {
      throw new WebMcpActionableError(
        "Operation 'paint_fill' requires 'fill_color' (e.g. '#3b82f6').",
        "MISSING_PARAMETER",
        true,
        "Provide a hex color string in fill_color.",
      );
    }
    const targetTexture = getAndActivateTexture(textureRef || undefined);
    const rect = Array.isArray(args.rect) && args.rect.length === 4
      ? args.rect.map(Number)
      : [0, 0, targetTexture.width || 16, targetTexture.height || 16];

    runUndoableEdit(
      { textures: [targetTexture], bitmap: true },
      `WebMCP: Paint fill on ${targetTexture.name}`,
      () => {
        const { ctx } = targetTexture.getActiveCanvas();
        ctx.fillStyle = fillColor;
        ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
        targetTexture.updateChangesAfterEdit();
      },
    );

    return {
      status: "painted",
      texture_id: targetTexture.uuid,
      name: targetTexture.name,
      rect,
      fill_color: fillColor,
    };
  }

  if (operation === "assign_texture") {
    const targetTexture = getAndActivateTexture(textureRef || undefined);
    const targetIds = Array.isArray(args.target_ids) ? args.target_ids.map(String) : [];
    if (targetIds.length === 0) {
      throw new WebMcpActionableError(
        "Operation 'assign_texture' requires 'target_ids' with at least one element or group.",
        "MISSING_PARAMETER",
        true,
        "Call list_outliner_items first to find element names or UUIDs.",
      );
    }
    const nodes = targetIds.map(id => findElementOrThrow(id));
    const elements = nodes.filter((n): n is OutlinerElement => !(typeof Group !== "undefined" && n instanceof Group));

    runUndoableEdit(
      { elements, uv_only: false },
      `WebMCP: Assign texture ${targetTexture.name}`,
      () => {
        elements.forEach(el => {
          const textured = el as unknown as { applyTexture?: (tex: Texture, faces: boolean) => void };
          textured.applyTexture?.(targetTexture, true);
        });
      },
    );

    return {
      status: "assigned",
      texture_id: targetTexture.uuid,
      texture_name: targetTexture.name,
      assigned_count: elements.length,
    };
  }

  if (operation === "configure_material") {
    const materialName = typeof args.material_name === "string" && args.material_name.trim()
      ? args.material_name.trim()
      : "material";
    const channelParse = pbrChannelEnum.safeParse(args.pbr_channel ?? "color");
    if (!channelParse.success) {
      throw new WebMcpActionableError(
        `Unsupported PBR channel "${String(args.pbr_channel)}".`,
        "INVALID_ARGUMENTS",
        true,
        "Choose one of: color, normal, height, mer.",
      );
    }
    const texture = textureRef ? getProjectTexture(textureRef) : null;
    if (textureRef && !texture) {
      throw new WebMcpActionableError(
        `Texture "${textureRef}" not found for material configuration.`,
        "NOT_FOUND",
        true,
        "Call list_textures first or create the texture with manage_textures.",
      );
    }

    const existingGroup = typeof TextureGroup !== "undefined"
      ? TextureGroup.all.find(g => g.uuid === materialName || g.name === materialName)
      : undefined;
    // A new group is added inside the material edit so undo removes it together with the channel change.
    const group = existingGroup ?? new TextureGroup({ name: materialName, is_material: true });
    const changes: ITextureChange[] = texture
      ? [{ texture, group: group.uuid, channel: channelParse.data }]
      : [];
    commitMaterialEdit(group, changes, {}, `WebMCP: Configure material ${group.name}`);

    return {
      status: "configured_material",
      material_id: group.uuid,
      material_name: group.name,
      ...(texture ? { assigned_texture: texture.name, pbr_channel: channelParse.data } : {}),
    };
  }

  throw new WebMcpActionableError(
    `Unsupported texture operation "${operation}".`,
    "INVALID_OPERATION",
    true,
    "Choose one of: create_texture, paint_fill, assign_texture, configure_material.",
  );
}

/**
 * Execute handler for `switch_editor_mode` (Goal 3).
 * Navigation tool: omits `readOnlyHint` and `consequentialHint` per WebMCP spec.
 */
async function executeSwitchEditorMode(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const targetMode = String(args.target_mode ?? "").trim();
  const options = (typeof Modes !== "undefined" && Modes?.options)
    ? (Modes.options as Record<string, Mode>)
    : {};

  if (!Object.hasOwn(options, targetMode)) {
    const available = Object.keys(options).toSorted().join(", ");
    throw new WebMcpActionableError(
      `Workspace mode "${targetMode}" is not registered. Available modes: ${available}.`,
      "INVALID_MODE",
      true,
      "Choose a supported mode such as 'edit', 'paint', 'animate', or 'display'.",
    );
  }

  const modeObj = options[targetMode];
  if (typeof Condition === "function" && modeObj.condition !== undefined && !Condition(modeObj.condition)) {
    throw new WebMcpActionableError(
      `Workspace mode "${targetMode}" is not supported by the current project format.`,
      "MODE_UNAVAILABLE",
      false,
      "Check get_project_summary to verify format capabilities.",
    );
  }

  const previousMode = getActiveModeId();
  if (previousMode !== targetMode) {
    modeObj.select();
  }

  return {
    status: previousMode === targetMode ? "unchanged" : "switched",
    previous_mode: previousMode,
    current_mode: getActiveModeId() ?? targetMode,
  };
}

/**
 * Execute handler for `manage_animations` (Goal 3).
 */
async function executeManageAnimations(args: Record<string, unknown>): Promise<unknown> {
  requireActiveProject();
  const operation = String(args.operation ?? "list");
  const activeMode = getActiveModeId();

  const AnimClass = (
    typeof Blockbench !== "undefined" && "Animation" in Blockbench
      ? (Blockbench as unknown as { Animation: typeof BBAnimation }).Animation
      : typeof Animation !== "undefined"
        ? (Animation as unknown as typeof BBAnimation)
        : undefined
  );

  if (operation !== "list" && activeMode !== "animate") {
    throw new WebMcpActionableError(
      `Animation tools require the Animate workspace tab to be active (current mode: '${activeMode ?? "none"}').`,
      "PREREQUISITE_MODE",
      true,
      "Call switch_editor_mode with target_mode='animate' first, then retry manage_animations.",
    );
  }

  if (operation === "list") {
    const page = typeof args.page === "number" ? args.page : 1;
    const clips = (AnimClass?.all ?? []).map((anim: BBAnimation) => ({
      id: anim.uuid,
      name: anim.name,
      duration: anim.length,
      loop: anim.loop,
      selected: AnimClass?.selected === anim,
    }));
    return paginateWebMcpItems(clips, page, WEBMCP_DEFAULT_PAGE_SIZE);
  }

  if (!AnimClass) {
    throw new WebMcpActionableError(
      "Animation subsystem is unavailable in this Blockbench environment.",
      "SUBSYSTEM_UNAVAILABLE",
      false,
    );
  }

  if (operation === "create") {
    const animName = String(args.animation_name ?? "").trim() || "animation.model.new";
    const duration = Number(args.duration ?? 1.0);
    const loopMode = (typeof args.loop_mode === "string" ? args.loop_mode : "loop") as "once" | "loop" | "hold";
    const createdAnims: BBAnimation[] = [];

    const created = runUndoableEdit(
      { animations: createdAnims },
      `WebMCP: Create animation ${animName}`,
      () => {
        const anim = new AnimClass({
          name: animName,
          length: duration,
          loop: loopMode,
        }).add(true);
        createdAnims.push(anim);
        return anim;
      },
    );

    return {
      status: "created",
      animation_id: created.uuid,
      name: created.name,
      duration: created.length,
      loop_mode: created.loop,
    };
  }

  if (operation === "set_keyframes") {
    const animRef = String(args.animation_name ?? "").trim();
    const boneName = String(args.bone_name ?? "").trim();
    const channel = (typeof args.channel === "string" ? args.channel : "rotation") as
      | "rotation"
      | "position"
      | "scale";
    const keyframes = Array.isArray(args.keyframes) ? (args.keyframes as IKeyframeSpec[]) : [];

    const anim = AnimClass.all.find((a: BBAnimation) => a.uuid === animRef || a.name === animRef) ?? AnimClass.selected;
    if (!anim) {
      throw new WebMcpActionableError(
        `Animation "${animRef || "selected"}" not found.`,
        "NOT_FOUND",
        true,
        "Call manage_animations with operation='list' or 'create' first.",
      );
    }
    if (!boneName || keyframes.length === 0) {
      throw new WebMcpActionableError(
        "Operation 'set_keyframes' requires both 'bone_name' and a non-empty 'keyframes' array.",
        "MISSING_PARAMETER",
        true,
        "Provide bone_name and keyframes=[{ time, values: [x, y, z] }].",
      );
    }

    const group = findGroupOrThrow(boneName);
    anim.select();

    runUndoableEdit(
      { animations: [anim] },
      `WebMCP: Set ${keyframes.length} keyframe(s) on ${group.name}`,
      () => {
        // The animator is resolved inside the edit so a newly created one is rolled back on failure.
        const animator = requireBoneAnimator(anim, group);
        keyframes.forEach(kf => {
          // Blockbench ignores x/y/z passed through `data_points`; values are written via `Keyframe.set`.
          const frame = animator.addKeyframe({
            channel,
            time: kf.time,
            data_points: [{}],
            interpolation: kf.interpolation ?? "linear",
          });
          if (!frame) throw new Error(`Channel "${channel}" is not animatable on bone "${group.name}".`);
          applyKeyframeValues(frame, kf.values);
        });
        anim.setLength();
      },
    );

    return {
      status: "keyframes_set",
      animation_id: anim.uuid,
      bone_name: group.name,
      channel,
      keyframe_count: keyframes.length,
    };
  }

  if (operation === "playback") {
    const state = String(args.playback_state ?? "play");
    if (typeof Timeline !== "undefined" && Timeline) {
      if (state === "play" && typeof Timeline.start === "function") Timeline.start();
      if (state === "pause" && typeof Timeline.pause === "function") Timeline.pause();
      if (state === "stop" && typeof Timeline.pause === "function") {
        Timeline.pause();
        Timeline.setTime?.(0);
      }
    }
    return {
      status: "playback_updated",
      playback_state: state,
    };
  }

  throw new WebMcpActionableError(
    `Unsupported animation operation "${operation}".`,
    "INVALID_OPERATION",
    true,
    "Choose one of: list, create, set_keyframes, playback.",
  );
}

/**
 * Execute handler for `export_project_model` (Goal 3).
 * Designed specifically for the `web` variant of Blockbench (no Node `fs` paths):
 * supports listing codecs, paging through compiled output within the 1,500-char budget,
 * or initiating the browser download dialog (`requires_user_action` hand-off).
 */
async function executeExportProjectModel(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "list_codecs");
  const registry = (typeof Codecs !== "undefined" && Codecs ? Codecs : {}) as Record<
    string,
    {
      id?: string;
      name?: string;
      extension?: string;
      compile?: (options?: unknown) => unknown;
      export?: () => unknown;
    }
  >;

  if (action === "list_codecs") {
    const codecs = Object.entries(registry)
      .map(([id, codec]) => ({
        id,
        name: codec.name ?? id,
        extension: codec.extension ?? null,
        can_compile: typeof codec.compile === "function",
        can_download: typeof codec.export === "function",
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
    return paginateWebMcpItems(codecs, 1, WEBMCP_DEFAULT_PAGE_SIZE);
  }

  requireActiveProject();
  const formatCodecId = (typeof Format !== "undefined" && Format
    ? (Format as { codec?: { id?: string } }).codec?.id
    : undefined) ?? "project";
  const requestedId = typeof args.codec_id === "string" && args.codec_id.trim()
    ? args.codec_id.trim()
    : formatCodecId;

  const codec = registry[requestedId];
  if (!codec) {
    throw new WebMcpActionableError(
      `Codec "${requestedId}" is not registered.`,
      "INVALID_CODEC",
      true,
      "Call export_project_model with action='list_codecs' to see valid codec_id values.",
    );
  }

  if (action === "initiate_download") {
    if (typeof codec.export !== "function") {
      throw new WebMcpActionableError(
        `Codec "${requestedId}" does not support browser download export.`,
        "EXPORT_UNSUPPORTED",
        false,
      );
    }
    await codec.export();
    return {
      status: "requires_user_action",
      codec_id: requestedId,
      extension: codec.extension ?? null,
      message: "Triggered Blockbench's browser save/download dialog for the user to confirm.",
    };
  }

  if (typeof codec.compile !== "function") {
    throw new WebMcpActionableError(
      `Codec "${requestedId}" does not expose an in-memory compile() method.`,
      "COMPILE_UNSUPPORTED",
      true,
      "Use action='initiate_download' or choose another codec from list_codecs.",
    );
  }

  const compiledRaw = await codec.compile();
  const text = typeof compiledRaw === "string"
    ? compiledRaw
    : JSON.stringify(compiledRaw);
  const offset = Math.min(text.length, Math.max(0, Math.trunc(Number(args.offset ?? 0))));
  const limit = Math.min(EXPORT_MAX_LIMIT, Math.max(EXPORT_MIN_LIMIT, Math.trunc(Number(args.limit ?? EXPORT_DEFAULT_LIMIT))));

  const envelope = (sliceLength: number): Record<string, unknown> => {
    const slice = text.slice(offset, offset + sliceLength);
    const nextOffset = offset + slice.length;
    return {
      status: "compiled",
      codec_id: requestedId,
      extension: codec.extension ?? "json",
      total_length: text.length,
      offset,
      returned_length: slice.length,
      truncated: nextOffset < text.length,
      ...(nextOffset < text.length ? { next_offset: nextOffset } : {}),
      content: slice,
    };
  };
  // Compiled JSON is quote-heavy, so the escaped envelope can exceed the raw slice length;
  // the slice shrinks until the serialized response honours the output budget exactly.
  const fitSlice = (sliceLength: number): number =>
    sliceLength <= EXPORT_MIN_LIMIT || JSON.stringify(envelope(sliceLength)).length <= WEBMCP_MAX_OUTPUT_CHARS
      ? sliceLength
      : fitSlice(Math.floor(sliceLength * 0.9));

  return envelope(fitSlice(limit));
}

/**
 * Returns the complete suite of 10 consolidated WebMCP tools designed for
 * Blockbench `variant: "web"`.
 */
export function createBlockbenchWebMcpTools(): readonly IWebMcpToolDefinition[] {
  return [
    {
      ...getSchemaEntry("get_project_summary"),
      execute: executeGetProjectSummary,
    },
    {
      ...getSchemaEntry("create_project"),
      execute: executeCreateProject,
    },
    {
      ...getSchemaEntry("list_outliner_items"),
      condition: { project: true },
      execute: executeListOutlinerItems,
    },
    {
      ...getSchemaEntry("mutate_outliner_items"),
      condition: { project: true },
      execute: executeMutateOutlinerItems,
    },
    {
      ...getSchemaEntry("manage_history"),
      condition: { project: true },
      execute: executeManageHistory,
    },
    {
      ...getSchemaEntry("list_textures"),
      condition: { project: true },
      execute: executeListTextures,
    },
    {
      ...getSchemaEntry("manage_textures"),
      condition: { project: true },
      execute: executeManageTextures,
    },
    {
      ...getSchemaEntry("switch_editor_mode"),
      condition: { project: true },
      execute: executeSwitchEditorMode,
    },
    {
      ...getSchemaEntry("manage_animations"),
      condition: { project: true },
      execute: executeManageAnimations,
    },
    {
      ...getSchemaEntry("export_project_model"),
      execute: executeExportProjectModel,
    },
  ];
}
