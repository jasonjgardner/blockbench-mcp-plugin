/// <reference types="three" />
/// <reference types="blockbench-types" />
import server from "./server";
import { getProjectTexture } from "../lib/util";
import type { ResourceTemplate } from "fastmcp";
import type { BlockbenchSessionAuth } from "./types";

const nodesResource: ResourceTemplate<BlockbenchSessionAuth> = {
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

const texturesResource: ResourceTemplate<BlockbenchSessionAuth> = {
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

const referenceModelResource: ResourceTemplate<BlockbenchSessionAuth> = {
  name: "reference_model",
  description: "Returns the current reference model in the Blockbench editor.",
  uriTemplate: "reference_model://{id}",
  arguments: [
    {
      name: "id",
    },
  ],
  async load({ id }) {
    const reference = Project?.elements.find((element) => {
      return (
        element.mesh.type === "reference_model" &&
        (element.uuid === id || element.name === id)
      );
    });

    if (!reference) {
      throw new Error(`Reference model with ID "${id}" not found.`);
    }

    const { position, rotation, scale, ...rest } = reference.mesh;

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

server.addResourceTemplate(referenceModelResource);
