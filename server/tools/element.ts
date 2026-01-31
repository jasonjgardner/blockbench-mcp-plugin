/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { findElementOrThrow } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import {
  elementIdSchema,
  vector3Schema,
  autoUvEnum,
} from "@/lib/zodObjects";

export function registerElementTools() {
  createTool(
  "remove_element",
  {
    description: "Removes the element with the given ID.",
    annotations: {
      title: "Remove Element",
      destructiveHint: true,
    },
    parameters: z.object({
      id: elementIdSchema.describe("ID or name of the element to remove."),
    }),
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
  },
  STATUS_EXPERIMENTAL
  );

  createTool(
    "add_group",
    {
      description: "Adds a new group with the given name and options.",
      annotations: {
        title: "Add Group",
        destructiveHint: true,
      },
      parameters: z.object({
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
      }),
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

        group.addTo(
          getAllGroups().find((g) => g.name === parent || g.uuid === parent)
        );

        Undo.finishEdit("Agent added group");
        Canvas.updateAll();

        return `Added group ${group.name} with ID ${group.uuid}`;
      },
    },
    STATUS_STABLE
  );

  createTool(
    "list_outline",
    {
      description:
        "Returns a list of all groups and their children in the Blockbench editor.",
      annotations: {
        title: "List Outline",
        readOnlyHint: true,
      },
      parameters: z.object({}),
      async execute() {
        const elements = Outliner.elements;

        return JSON.stringify(
          elements.map((element) => {
            const { name, uuid } = element;
            return {
              name,
              uuid,
            };
          }),
          null,
          2
        );
      },
    },
    STATUS_STABLE
  );

createTool(
  "duplicate_element",
  {
    description:
      "Duplicates a cube, mesh or group by ID or name.  You may offset the duplicate or assign a new name.",
    annotations: { title: "Duplicate Element", destructiveHint: true },
    parameters: z.object({
      id: elementIdSchema.describe("ID or name of the element to duplicate."),
      offset: vector3Schema.optional().default([0, 0, 0]),
      newName: z.string().optional(),
    }),
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
  },
  STATUS_EXPERIMENTAL
);

/**
 * Rename an element.  Mirrors the simple property change seen in the existing tools,
 * using `extend` to apply the change and updating the editor.
 */
createTool(
  "rename_element",
  {
    description: "Renames a cube, mesh or group by ID or name.",
    annotations: { title: "Rename Element", destructiveHint: true },
    parameters: z.object({
      id: elementIdSchema.describe("ID or name of the element to rename."),
      new_name: z.string().describe("New name to assign."),
    }),
    async execute({ id, new_name }) {
      const element = findElementOrThrow(id);
      Undo.initEdit({ elements: [element], outliner: true, collections: [] });
      element.extend({ name: new_name });
      Undo.finishEdit("Agent renamed element");
      Canvas.updateAll();
      return `Renamed element "${id}" to "${new_name}".`;
    },
  },
  STATUS_EXPERIMENTAL
);
}
