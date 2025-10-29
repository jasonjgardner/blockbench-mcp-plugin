/// <reference types="three" />
/// <reference types="blockbench-types" />
import server from "./server";
import { getProjectTexture } from "../lib/util";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlockbenchSessionAuth } from "./types";

server.registerResource(
  "nodes",
  new ResourceTemplate("nodes://{id}", {
    list: undefined,
    complete: {
      id: async (value: string) => {
        if (!Project?.nodes_3d) {
          return [];
        }

        const nodeKeys = Object.keys(Project.nodes_3d);

        if (value.length > 0) {
          return nodeKeys.filter((key) => key.includes(value));
        }

        return nodeKeys;
      },
    },
  }),
  {
    title: "Nodes",
    description: "Returns the current nodes in the Blockbench editor.",
  },
  async (uri, { id }) => {
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
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            ...rest,
            position: position.toArray(),
            rotation: rotation.toArray(),
            scale: scale.toArray(),
          }),
        },
      ],
    };
  }
);

server.registerResource(
  "textures",
  new ResourceTemplate("textures://{id}", {
    list: undefined,
    complete: {
      id: async (value: string) => {
        const textures = Project?.textures ?? Texture.all;

        if (value.length > 0) {
          const filteredTextures = textures.filter((texture) =>
            texture.name.includes(value)
          );
          return filteredTextures.map((texture) => texture.name);
        }

        return textures.map((texture) => texture.name);
      },
    },
  }),
  {
    title: "Textures",
    description: "Returns the current textures in the Blockbench editor.",
  },
  async (uri, { id }) => {
    const texture = getProjectTexture(id);

    if (!texture) {
      throw new Error(`Texture with ID "${id}" not found.`);
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "image/png",
          blob: await new Promise((resolve) => {
            resolve(texture.getBase64());
          }),
        },
      ],
    };
  }
);

server.registerResource(
  "reference_model",
  new ResourceTemplate("reference_model://{id}", {
    list: undefined,
  }),
  {
    title: "Reference Model",
    description: "Returns the current reference model in the Blockbench editor.",
  },
  async (uri, { id }) => {
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
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            ...rest,
            position: position.toArray(),
            rotation: rotation.toArray(),
            scale: scale.toArray(),
          }),
        },
      ],
    };
  }
);

server.registerResource(
  "project",
  new ResourceTemplate("project://{name}", {
    list: undefined,
    complete: {
      name: async (value: string) => {
        const projects = ModelProject.all;

        if (value.length > 0) {
          const filteredProjects = projects.filter((project) =>
            project.name.includes(value)
          );
          return filteredProjects.map((project) => project.name);
        }

        return projects.map((project) => project.name);
      },
    },
  }),
  {
    title: "Project",
    description: "Returns a list of all projects in the Blockbench editor.",
  },
  async (uri, { name }) => {
    const projects = ModelProject.all;

    let project;

    if (name) {
      project = projects.find((project) => project.name === name);
    }

    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(
            project ? [project.name] : projects.map((project) => project.name)
          ),
        },
      ],
    };
  }
);

server.registerResource(
  "scope",
  new ResourceTemplate("scope://{name}", {
    list: undefined,
    complete: {
      name: async (value: string) => {
        const scopes = Object.keys(globalThis);

        if (value.length > 0) {
          return scopes.filter((scope) => scope.includes(value));
        }

        return scopes;
      },
    },
  }),
  {
    title: "Scope",
    description: "Returns the current scope in the Blockbench editor.",
  },
  async (uri, { name }) => {
    const scopes = Object.keys(globalThis);

    let scope;

    if (name) {
      scope = scopes.find((scope) => scope === name);
    }

    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(scope ? [scope] : scopes),
        },
      ],
    };
  }
);
