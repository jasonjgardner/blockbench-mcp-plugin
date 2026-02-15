/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import {
  elementIdSchema,
  vector3Schema,
  meshIdOptionalSchema,
} from "@/lib/zodObjects";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find an armature by UUID or name
 */
function findArmature(id: string): Armature | undefined {
  return Armature.all.find(
    (a) => a.uuid === id || a.name === id || a.uuid.startsWith(id)
  );
}

/**
 * Find an armature or throw an error
 */
function findArmatureOrThrow(id: string): Armature {
  const armature = findArmature(id);
  if (!armature) {
    throw new Error(`Armature not found: ${id}`);
  }
  return armature;
}

/**
 * Find an armature bone by UUID or name
 */
function findArmatureBone(id: string): ArmatureBone | undefined {
  return ArmatureBone.all.find(
    (b) => b.uuid === id || b.name === id || b.uuid.startsWith(id)
  );
}

/**
 * Find an armature bone or throw an error
 */
function findArmatureBoneOrThrow(id: string): ArmatureBone {
  const bone = findArmatureBone(id);
  if (!bone) {
    throw new Error(`Armature bone not found: ${id}`);
  }
  return bone;
}

/**
 * Find a mesh by UUID or name
 */
function findMesh(id: string): Mesh | undefined {
  return Mesh.all.find(
    (m) => m.uuid === id || m.name === id || m.uuid.startsWith(id)
  );
}

/**
 * Serialize an armature to a plain object
 */
function serializeArmature(armature: Armature) {
  return {
    uuid: armature.uuid,
    name: armature.name,
    type: armature.type,
    visibility: armature.visibility,
    locked: armature.locked,
    export: armature.export,
    isOpen: armature.isOpen,
    origin: armature.origin,
    childCount: armature.children.length,
    boneCount: armature.getAllBones().length,
  };
}

/**
 * Serialize an armature bone to a plain object
 */
function serializeArmatureBone(bone: ArmatureBone) {
  const armature = bone.getArmature();
  return {
    uuid: bone.uuid,
    name: bone.name,
    type: bone.type,
    armature: armature ? { uuid: armature.uuid, name: armature.name } : null,
    origin: bone.origin,
    rotation: bone.rotation,
    length: bone.length,
    width: bone.width,
    connected: bone.connected,
    color: bone.color,
    visibility: bone.visibility,
    locked: bone.locked,
    export: bone.export,
    parentBone: bone.parent instanceof ArmatureBone
      ? { uuid: bone.parent.uuid, name: bone.parent.name }
      : null,
    childCount: bone.children.length,
    vertexWeightCount: Object.keys(bone.vertex_weights).length,
  };
}

// ============================================================================
// Armature Tool Parameter Schemas
// ============================================================================

export const listArmaturesParameters = z.object({});

export const getArmatureParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the armature."),
  include_bones: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include bone hierarchy in response."),
});

export const addArmatureParameters = z.object({
  name: z.string().optional().default("armature").describe("Name for the new armature."),
  visibility: z.boolean().optional().default(true),
  locked: z.boolean().optional().default(false),
  add_initial_bone: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to add an initial bone to the armature."),
});

export const removeArmatureParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the armature to remove."),
});

export const updateArmatureParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the armature."),
  name: z.string().optional().describe("New name for the armature."),
  visibility: z.boolean().optional(),
  locked: z.boolean().optional(),
  export: z.boolean().optional().describe("Whether to export this armature."),
});

export const listArmatureBonesParameters = z.object({
  armature_id: z
    .string()
    .optional()
    .describe("Filter bones by armature UUID or name. If not provided, lists all bones."),
});

export const getArmatureBoneParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the bone."),
  include_weights: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to include all vertex weights in response."),
});

export const addArmatureBoneParameters = z.object({
  parent_id: elementIdSchema.describe(
    "UUID or name of parent armature or bone."
  ),
  name: z.string().optional().default("bone").describe("Name for the new bone."),
  origin: vector3Schema
    .optional()
    .describe("Position of the bone. Defaults to [0, parent.length, 0] for child bones."),
  rotation: vector3Schema.optional().default([0, 0, 0]),
  length: z.number().optional().default(8).describe("Length of the bone."),
  width: z.number().optional().default(2).describe("Width of the bone."),
  connected: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether bone is connected to parent."),
  color: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe("Marker color index (0-7)."),
});

export const removeArmatureBoneParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the bone to remove."),
  remove_children: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to also remove child bones."),
});

export const updateArmatureBoneParameters = z.object({
  id: elementIdSchema.describe("UUID or name of the bone."),
  name: z.string().optional(),
  origin: vector3Schema.optional().describe("New position of the bone."),
  rotation: vector3Schema.optional().describe("New rotation [x, y, z] in degrees."),
  length: z.number().optional(),
  width: z.number().optional(),
  connected: z.boolean().optional(),
  color: z.number().int().min(0).max(7).optional(),
  visibility: z.boolean().optional(),
  locked: z.boolean().optional(),
});

export const updateArmatureBonesBatchParameters = z.object({
  ids: z.array(elementIdSchema).describe("Array of bone UUIDs or names to update."),
  visibility: z.boolean().optional(),
  locked: z.boolean().optional(),
  color: z.number().int().min(0).max(7).optional(),
});

export const selectArmatureBonesParameters = z.object({
  ids: z
    .array(elementIdSchema)
    .optional()
    .describe("Array of bone UUIDs or names to select."),
  armature_id: z
    .string()
    .optional()
    .describe("Select all bones in this armature."),
  include_descendants: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include all descendant bones in selection."),
  clear_selection: z
    .boolean()
    .optional()
    .default(true)
    .describe("Clear existing selection before selecting."),
});

export const getVertexWeightsParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  bone_id: z
    .string()
    .optional()
    .describe("Filter weights by specific bone."),
});

export const setVertexWeightParameters = z.object({
  bone_id: elementIdSchema.describe("UUID or name of the bone."),
  mesh_id: meshIdOptionalSchema,
  vertex_key: z.string().describe("Key of the vertex in the mesh."),
  weight: z
    .number()
    .min(0)
    .max(1)
    .describe("Weight value (0-1). Set to 0 to remove weight."),
});

export const setVertexWeightsBatchParameters = z.object({
  bone_id: elementIdSchema.describe("UUID or name of the bone."),
  mesh_id: meshIdOptionalSchema,
  weights: z
    .record(z.string(), z.number().min(0).max(1))
    .describe("Map of vertex_key -> weight value."),
});

export const clearVertexWeightsParameters = z.object({
  bone_id: elementIdSchema.describe("UUID or name of the bone."),
  mesh_id: meshIdOptionalSchema,
});

// ============================================================================
// Armature Tool Docs
// ============================================================================

export const armatureToolDocs: ToolSpec[] = [
  {
    name: "list_armatures",
    description:
      "Lists all armatures in the current project with their basic info.",
    annotations: {
      title: "List Armatures",
      readOnlyHint: true,
    },
    parameters: listArmaturesParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_armature",
    description:
      "Gets detailed information about a specific armature including its bones.",
    annotations: {
      title: "Get Armature",
      readOnlyHint: true,
    },
    parameters: getArmatureParameters,
    status: STATUS_STABLE,
  },
  {
    name: "add_armature",
    description:
      "Creates a new armature in the project. An armature is a skeletal rig used for mesh deformation.",
    annotations: {
      title: "Add Armature",
      destructiveHint: true,
    },
    parameters: addArmatureParameters,
    status: STATUS_STABLE,
  },
  {
    name: "remove_armature",
    description: "Removes an armature and all its bones from the project.",
    annotations: {
      title: "Remove Armature",
      destructiveHint: true,
    },
    parameters: removeArmatureParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "update_armature",
    description: "Updates properties of an existing armature.",
    annotations: {
      title: "Update Armature",
      destructiveHint: true,
    },
    parameters: updateArmatureParameters,
    status: STATUS_STABLE,
  },
  {
    name: "list_armature_bones",
    description:
      "Lists all armature bones, optionally filtered by a specific armature.",
    annotations: {
      title: "List Armature Bones",
      readOnlyHint: true,
    },
    parameters: listArmatureBonesParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_armature_bone",
    description: "Gets detailed information about a specific armature bone.",
    annotations: {
      title: "Get Armature Bone",
      readOnlyHint: true,
    },
    parameters: getArmatureBoneParameters,
    status: STATUS_STABLE,
  },
  {
    name: "add_armature_bone",
    description:
      "Creates a new bone and adds it to an armature or parent bone.",
    annotations: {
      title: "Add Armature Bone",
      destructiveHint: true,
    },
    parameters: addArmatureBoneParameters,
    status: STATUS_STABLE,
  },
  {
    name: "remove_armature_bone",
    description: "Removes an armature bone from the project.",
    annotations: {
      title: "Remove Armature Bone",
      destructiveHint: true,
    },
    parameters: removeArmatureBoneParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "update_armature_bone",
    description: "Updates properties of an existing armature bone.",
    annotations: {
      title: "Update Armature Bone",
      destructiveHint: true,
    },
    parameters: updateArmatureBoneParameters,
    status: STATUS_STABLE,
  },
  {
    name: "update_armature_bones_batch",
    description: "Updates multiple armature bones at once with the same properties.",
    annotations: {
      title: "Update Armature Bones (Batch)",
      destructiveHint: true,
    },
    parameters: updateArmatureBonesBatchParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "select_armature_bones",
    description:
      "Selects armature bones by ID. Can select single bone, multiple bones, or bone hierarchy.",
    annotations: {
      title: "Select Armature Bones",
      destructiveHint: false,
    },
    parameters: selectArmatureBonesParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_vertex_weights",
    description:
      "Gets vertex weights for a mesh from all bones affecting it.",
    annotations: {
      title: "Get Vertex Weights",
      readOnlyHint: true,
    },
    parameters: getVertexWeightsParameters,
    status: STATUS_STABLE,
  },
  {
    name: "set_vertex_weight",
    description: "Sets the weight of a specific vertex on a bone.",
    annotations: {
      title: "Set Vertex Weight",
      destructiveHint: true,
    },
    parameters: setVertexWeightParameters,
    status: STATUS_STABLE,
  },
  {
    name: "set_vertex_weights_batch",
    description: "Sets multiple vertex weights at once on a bone.",
    annotations: {
      title: "Set Vertex Weights (Batch)",
      destructiveHint: true,
    },
    parameters: setVertexWeightsBatchParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "clear_vertex_weights",
    description: "Clears all vertex weights from a bone for a specific mesh.",
    annotations: {
      title: "Clear Vertex Weights",
      destructiveHint: true,
    },
    parameters: clearVertexWeightsParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

// ============================================================================
// Armature Tools
// ============================================================================

export function registerArmatureTools() {
  // ---------------------------------------------------------------------------
  // List Armatures
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[0].name, {
    ...armatureToolDocs[0],
    async execute() {
      const armatures = Armature.all.map(serializeArmature);
      return JSON.stringify(
        {
          count: armatures.length,
          armatures,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[0].status);

  // ---------------------------------------------------------------------------
  // Get Armature
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[1].name, {
    ...armatureToolDocs[1],
    async execute({ id, include_bones }) {
      const armature = findArmatureOrThrow(id);
      const result = serializeArmature(armature);

      if (include_bones) {
        const bones = armature.getAllBones().map(serializeArmatureBone);
        return JSON.stringify({ ...result, bones }, null, 2);
      }

      return JSON.stringify(result, null, 2);
    },
  }, armatureToolDocs[1].status);

  // ---------------------------------------------------------------------------
  // Add Armature
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[2].name, {
    ...armatureToolDocs[2],
    async execute({ name, visibility, locked, add_initial_bone }) {
      // Check if format supports armatures
      if (!Format.armature_rig) {
        throw new Error(
          "Current format does not support armatures. Switch to a format that supports armature rigs."
        );
      }

      Undo.initEdit({ outliner: true, elements: [] });

      const armature = new Armature({
        name,
        visibility,
        locked,
      });
      armature.addTo(Outliner.root as any);
      armature.isOpen = true;
      armature.createUniqueName();
      armature.init();

      const elements: OutlinerElement[] = [armature];

      if (add_initial_bone) {
        const bone = new ArmatureBone({ name: "bone" });
        bone.addTo(armature);
        bone.init();
        elements.push(bone);
      }

      Undo.finishEdit("Agent added armature", { outliner: true, elements });
      Canvas.updateAll();

      return JSON.stringify(
        {
          message: `Created armature "${armature.name}"`,
          armature: serializeArmature(armature),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[2].status);

  // ---------------------------------------------------------------------------
  // Remove Armature
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[3].name, {
    ...armatureToolDocs[3],
    async execute({ id }) {
      const armature = findArmatureOrThrow(id);
      const name = armature.name;

      Undo.initEdit({ outliner: true, elements: [] });
      armature.remove();
      Undo.finishEdit("Agent removed armature");
      Canvas.updateAll();

      return `Removed armature "${name}"`;
    },
  }, armatureToolDocs[3].status);

  // ---------------------------------------------------------------------------
  // Update Armature
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[4].name, {
    ...armatureToolDocs[4],
    async execute({ id, name, visibility, locked, export: shouldExport }) {
      const armature = findArmatureOrThrow(id);

      Undo.initEdit({ outliner: true, elements: [armature] });

      if (name !== undefined) armature.name = name;
      if (visibility !== undefined) armature.visibility = visibility;
      if (locked !== undefined) armature.locked = locked;
      if (shouldExport !== undefined) armature.export = shouldExport;

      armature.updateElement();
      Undo.finishEdit("Agent updated armature");
      Canvas.updateAll();

      return JSON.stringify(
        {
          message: `Updated armature "${armature.name}"`,
          armature: serializeArmature(armature),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[4].status);

  // ---------------------------------------------------------------------------
  // List Armature Bones
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[5].name, {
    ...armatureToolDocs[5],
    async execute({ armature_id }) {
      let bones: ArmatureBone[];

      if (armature_id) {
        const armature = findArmatureOrThrow(armature_id);
        bones = armature.getAllBones();
      } else {
        bones = ArmatureBone.all;
      }

      const serialized = bones.map(serializeArmatureBone);
      return JSON.stringify(
        {
          count: serialized.length,
          bones: serialized,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[5].status);

  // ---------------------------------------------------------------------------
  // Get Armature Bone
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[6].name, {
    ...armatureToolDocs[6],
    async execute({ id, include_weights }) {
      const bone = findArmatureBoneOrThrow(id);
      const result = serializeArmatureBone(bone);

      if (include_weights) {
        return JSON.stringify(
          { ...result, vertex_weights: bone.vertex_weights },
          null,
          2
        );
      }

      return JSON.stringify(result, null, 2);
    },
  }, armatureToolDocs[6].status);

  // ---------------------------------------------------------------------------
  // Add Armature Bone
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[7].name, {
    ...armatureToolDocs[7],
    async execute({
      parent_id,
      name,
      origin,
      rotation,
      length,
      width,
      connected,
      color,
    }) {
      // Find parent (can be Armature or ArmatureBone)
      let parent: Armature | ArmatureBone | undefined = findArmature(parent_id);
      if (!parent) {
        parent = findArmatureBone(parent_id);
      }
      if (!parent) {
        throw new Error(`Parent not found: ${parent_id}. Must be an armature or bone.`);
      }

      // Calculate default origin if not provided
      const defaultOrigin: [number, number, number] =
        parent instanceof ArmatureBone ? [0, parent.length ?? 8, 0] : [0, 0, 0];

      Undo.initEdit({ outliner: true, elements: [] });

      const bone = new ArmatureBone({
        name,
        origin: (origin ?? defaultOrigin) as [number, number, number],
        rotation: rotation as [number, number, number],
        length,
        width,
        connected,
        color,
      });
      bone.addTo(parent);
      bone.isOpen = true;

      if (Format.bone_rig) {
        bone.createUniqueName();
      }

      bone.init();

      Undo.finishEdit("Agent added armature bone", { outliner: true, elements: [bone] });
      Canvas.updateAll();

      return JSON.stringify(
        {
          message: `Created bone "${bone.name}"`,
          bone: serializeArmatureBone(bone),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[7].status);

  // ---------------------------------------------------------------------------
  // Remove Armature Bone
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[8].name, {
    ...armatureToolDocs[8],
    async execute({ id, remove_children }) {
      const bone = findArmatureBoneOrThrow(id);
      const name = bone.name;

      Undo.initEdit({ outliner: true, elements: [] });

      if (!remove_children && bone.children.length > 0) {
        // Re-parent children to bone's parent
        const parent = bone.parent;
        for (const child of [...bone.children]) {
          child.addTo(parent);
        }
      }

      bone.remove();
      Undo.finishEdit("Agent removed armature bone");
      Canvas.updateAll();

      return `Removed bone "${name}"`;
    },
  }, armatureToolDocs[8].status);

  // ---------------------------------------------------------------------------
  // Update Armature Bone
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[9].name, {
    ...armatureToolDocs[9],
    async execute({
      id,
      name,
      origin,
      rotation,
      length,
      width,
      connected,
      color,
      visibility,
      locked,
    }) {
      const bone = findArmatureBoneOrThrow(id);

      Undo.initEdit({ outliner: true, elements: [bone] });

      if (name !== undefined) bone.name = name;
      if (origin !== undefined) bone.origin.V3_set(origin as [number, number, number]);
      if (rotation !== undefined) bone.rotation.V3_set(rotation as [number, number, number]);
      if (length !== undefined) bone.length = length;
      if (width !== undefined) bone.width = width;
      if (connected !== undefined) bone.connected = connected;
      if (color !== undefined) bone.setColor(color);
      if (visibility !== undefined) bone.visibility = visibility;
      if (locked !== undefined) bone.locked = locked;

      bone.preview_controller.updateTransform(bone);
      bone.updateElement();
      Undo.finishEdit("Agent updated armature bone");
      Canvas.updateAll();

      return JSON.stringify(
        {
          message: `Updated bone "${bone.name}"`,
          bone: serializeArmatureBone(bone),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[9].status);

  // ---------------------------------------------------------------------------
  // Update Armature Bones (Batch)
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[10].name, {
    ...armatureToolDocs[10],
    async execute({ ids, visibility, locked, color }) {
      const bones = ids.map(findArmatureBoneOrThrow);

      Undo.initEdit({ outliner: true, elements: bones });

      for (const bone of bones) {
        if (visibility !== undefined) bone.visibility = visibility;
        if (locked !== undefined) bone.locked = locked;
        if (color !== undefined) bone.setColor(color);
        bone.updateElement();
      }

      Undo.finishEdit("Agent updated armature bones (batch)");
      Canvas.updateAll();

      return JSON.stringify(
        {
          message: `Updated ${bones.length} bones`,
          bones: bones.map(serializeArmatureBone),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[10].status);

  // ---------------------------------------------------------------------------
  // Select Armature Bones
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[11].name, {
    ...armatureToolDocs[11],
    async execute({ ids, armature_id, include_descendants, clear_selection }) {
      if (clear_selection) {
        unselectAllElements();
      }

      let selectedBones: ArmatureBone[] = [];

      if (armature_id) {
        const armature = findArmatureOrThrow(armature_id);
        selectedBones = armature.getAllBones();
      } else if (ids && ids.length > 0) {
        for (const id of ids) {
          const bone = findArmatureBoneOrThrow(id);
          selectedBones.push(bone);

          if (include_descendants) {
            bone.forEachChild((child) => {
              if (child instanceof ArmatureBone) {
                selectedBones.push(child);
              }
            });
          }
        }
      }

      for (const bone of selectedBones) {
        bone.select();
      }

      updateSelection();

      return JSON.stringify(
        {
          message: `Selected ${selectedBones.length} bone(s)`,
          bones: selectedBones.map((b) => ({ uuid: b.uuid, name: b.name })),
        },
        null,
        2
      );
    },
  }, armatureToolDocs[11].status);

  // ---------------------------------------------------------------------------
  // Get Vertex Weights
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[12].name, {
    ...armatureToolDocs[12],
    async execute({ mesh_id, bone_id }) {
      // Find mesh
      let mesh: Mesh | undefined;
      if (mesh_id) {
        mesh = findMesh(mesh_id);
      } else {
        mesh = Mesh.selected[0];
      }
      if (!mesh) {
        throw new Error("No mesh found. Provide mesh_id or select a mesh.");
      }

      // Get armature for this mesh
      const armature = (mesh as any).getArmature?.() as Armature | undefined;
      if (!armature) {
        throw new Error(`Mesh "${mesh.name}" is not associated with an armature.`);
      }

      const bones = bone_id
        ? [findArmatureBoneOrThrow(bone_id)]
        : armature.getAllBones();

      const weights: Record<string, Record<string, number>> = {};

      for (const bone of bones) {
        const boneWeights: Record<string, number> = {};
        for (const vkey in mesh.vertices) {
          const weight = bone.getVertexWeight(mesh, vkey);
          if (weight > 0) {
            boneWeights[vkey] = weight;
          }
        }
        if (Object.keys(boneWeights).length > 0) {
          weights[bone.name] = boneWeights;
        }
      }

      return JSON.stringify(
        {
          mesh: { uuid: mesh.uuid, name: mesh.name },
          armature: { uuid: armature.uuid, name: armature.name },
          weights,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[12].status);

  // ---------------------------------------------------------------------------
  // Set Vertex Weight
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[13].name, {
    ...armatureToolDocs[13],
    async execute({ bone_id, mesh_id, vertex_key, weight }) {
      const bone = findArmatureBoneOrThrow(bone_id);

      let mesh: Mesh | undefined;
      if (mesh_id) {
        mesh = findMesh(mesh_id);
      } else {
        mesh = Mesh.selected[0];
      }
      if (!mesh) {
        throw new Error("No mesh found. Provide mesh_id or select a mesh.");
      }

      if (!(vertex_key in mesh.vertices)) {
        throw new Error(`Vertex "${vertex_key}" not found in mesh "${mesh.name}".`);
      }

      Undo.initEdit({ elements: [bone] });
      bone.setVertexWeight(mesh, vertex_key, weight);
      Undo.finishEdit("Agent set vertex weight");

      // Update mesh display
      Canvas.updateView({
        elements: [mesh],
        element_aspects: { geometry: true },
      });

      return JSON.stringify(
        {
          message: `Set weight ${weight} for vertex "${vertex_key}" on bone "${bone.name}"`,
          bone: { uuid: bone.uuid, name: bone.name },
          mesh: { uuid: mesh.uuid, name: mesh.name },
          vertex: vertex_key,
          weight,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[13].status);

  // ---------------------------------------------------------------------------
  // Set Vertex Weights (Batch)
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[14].name, {
    ...armatureToolDocs[14],
    async execute({ bone_id, mesh_id, weights }) {
      const bone = findArmatureBoneOrThrow(bone_id);

      let mesh: Mesh | undefined;
      if (mesh_id) {
        mesh = findMesh(mesh_id);
      } else {
        mesh = Mesh.selected[0];
      }
      if (!mesh) {
        throw new Error("No mesh found. Provide mesh_id or select a mesh.");
      }

      Undo.initEdit({ elements: [bone] });

      let count = 0;
      for (const [vertex_key, weight] of Object.entries(weights)) {
        if (vertex_key in mesh.vertices) {
          bone.setVertexWeight(mesh, vertex_key, weight);
          count++;
        }
      }

      Undo.finishEdit("Agent set vertex weights (batch)");

      Canvas.updateView({
        elements: [mesh],
        element_aspects: { geometry: true },
      });

      return JSON.stringify(
        {
          message: `Set ${count} vertex weights on bone "${bone.name}"`,
          bone: { uuid: bone.uuid, name: bone.name },
          mesh: { uuid: mesh.uuid, name: mesh.name },
          weightsSet: count,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[14].status);

  // ---------------------------------------------------------------------------
  // Clear Vertex Weights
  // ---------------------------------------------------------------------------
  createTool(armatureToolDocs[15].name, {
    ...armatureToolDocs[15],
    async execute({ bone_id, mesh_id }) {
      const bone = findArmatureBoneOrThrow(bone_id);

      let mesh: Mesh | undefined;
      if (mesh_id) {
        mesh = findMesh(mesh_id);
      } else {
        mesh = Mesh.selected[0];
      }
      if (!mesh) {
        throw new Error("No mesh found. Provide mesh_id or select a mesh.");
      }

      Undo.initEdit({ elements: [bone] });

      let count = 0;
      const meshPrefix = mesh.uuid.substring(0, 6) + ":";

      for (const key in bone.vertex_weights) {
        if (key.startsWith(meshPrefix)) {
          delete bone.vertex_weights[key];
          count++;
        }
      }

      Undo.finishEdit("Agent cleared vertex weights");

      Canvas.updateView({
        elements: [mesh],
        element_aspects: { geometry: true },
      });

      return JSON.stringify(
        {
          message: `Cleared ${count} vertex weights from bone "${bone.name}" for mesh "${mesh.name}"`,
          bone: { uuid: bone.uuid, name: bone.name },
          mesh: { uuid: mesh.uuid, name: mesh.name },
          weightsCleared: count,
        },
        null,
        2
      );
    },
  }, armatureToolDocs[15].status);
}
