/// <reference types="three" />
/// <reference path="../../../types/index.d.ts" />
import server from "./server";
import { fixCircularReferences, getProjectTexture } from "../lib/util";
import { ResourceTemplate } from "fastmcp";

server.addResource({
  name: "bar_items",
  description:
    "Returns the current toolbar options and actions in the Blockbench editor.",
  uri: "bar_items://",
  mimeType: "application/json",
  async load() {
    return await Promise.resolve([
      {
        type: "text",
        text: JSON.stringify(Object.keys(BarItems)),
      },
    ]);
  },
});

server.addResource({
  name: "dialog",
  description: "Returns the current dialogs in the Blockbench editor.",
  uri: "dialog://",
  mimeType: "application/json",
  async load() {
    return await Promise.resolve([
      {
        type: "text",
        text: JSON.stringify(
          Dialog.stack.map((d) => d.getFormResult()),
          null,
          2
        ),
      },
    ]);
  },
});

const nodesResource: ResourceTemplate = {
  name: "nodes",
  description: "Returns the current nodes in the Blockbench editor.",
  uriTemplate: "nodes://{id}",
  arguments: [
    {
      name: "id",
      description: "The ID of the node. Could be a UUID, name, or numeric ID.",
      complete: async (value: string) => {
        if (!Project?.nodes_3d) {
          return {
            values: [],
          };
        }

        const nodeKeys = Object.keys(Project.nodes_3d);

        if (value.length > 0) {
          const filteredKeys = nodeKeys.filter((key) => key.includes(value));

          return {
            values: filteredKeys,
          };
        }

        return {
          values: nodeKeys,
        };
      },
    },
  ],
  async load({ id }) {
    if (!Project?.nodes_3d) {
      throw new Error("No nodes found in the Blockbench editor.");
    }

    const node =
      Project.nodes_3d[id] ??
      Object.values(Project.nodes_3d).find(
        (node) => node.name === id || node.uuid === id
      );

    if (!node) {
      throw new Error(`Node with ID "${id}" not found.`);
    }

    const { position, rotation, scale, ...rest } = node;
    return {
      text: JSON.stringify({
        ...rest,
        position: position.toArray(),
        rotation: rotation.toArray(),
        scale: scale.toArray(),
      }),
    };
  },
};
server.addResourceTemplate(nodesResource);

const texturesResource: ResourceTemplate = {
  name: "textures",
  description: "Returns the current textures in the Blockbench editor.",
  uriTemplate: "textures://{id}",
  arguments: [
    {
      name: "id",
      description:
        "The ID of the texture. Could be a UUID, name, or numeric ID.",
      complete: async (value: string) => {
        const textures = Project?.textures ?? Texture.all;

        if (value.length > 0) {
          const filteredTextures = textures.filter((texture) =>
            texture.name.includes(value)
          );

          return {
            values: filteredTextures.map((texture) => texture.name),
          };
        }

        return {
          values: textures.map((texture) => texture.name),
        };
      },
    },
  ],
  async load({ id }) {
    const texture = getProjectTexture(id);

    if (!texture) {
      throw new Error(`Texture with ID "${id}" not found.`);
    }

    return {
      name: texture.name,
      blob: await new Promise((resolve) => {
        resolve(texture.getBase64());
      }),
    };
  },
};

server.addResourceTemplate(texturesResource);
