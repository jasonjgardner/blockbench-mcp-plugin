/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createResource } from "@/lib/factories";

// Register nodes resource using the factory pattern
createResource("nodes", {
  uriTemplate: "nodes://{id}",
  title: "Blockbench Nodes",
  description: "Returns the current nodes in the Blockbench editor.",
  async readCallback(uri, { id }) {
    if (!Project?.nodes_3d) {
      throw new Error("No nodes found in the Blockbench editor.");
    }

    const node =
      Project.nodes_3d[id as string] ??
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
  },
});

/*
// Resources below are commented out pending refactoring to official SDK API

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

// @ts-expect-error Blockbench does not need authentication
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

// @ts-expect-error Blockbench does not need authentication
server.addResourceTemplate(referenceModelResource);

const projectListResource: ResourceTemplate<BlockbenchSessionAuth> = {
  name: "project",
  description: "Returns a list of all projects in the Blockbench editor.",
  uriTemplate: "project://{name}",
  arguments: [
    {
      name: "name",
      description: "The name of the project.",
      complete: async (value: string) => {
        const projects = ModelProject.all;

        if (value.length > 0) {
          const filteredProjects = projects.filter((project) =>
            project.name.includes(value)
          );

          return {
            values: filteredProjects.map((project) => project.name),
          };
        }

        return {
          values: projects.map((project) => project.name),
        };
      },
    },
  ],
  async load({ name }) {
    const projects = ModelProject.all;

    let project;

    if (name) {
      project = projects.find((project) => project.name === name);
    }

    // TODO: Fix circular references and return more than just name
    return {
      text: JSON.stringify(
        project ? [project.name] : projects.map((project) => project.name)
      ),
    };
  },
};

// @ts-expect-error Blockbench does not need authentication
server.addResourceTemplate(projectListResource);

// Adds tools to better expose Blockbench scope, context, functions, etc.
// Check what variables are available in `globalThis` and report back the scope.
const scopeResource: ResourceTemplate<BlockbenchSessionAuth> = {
  name: "scope",
  description: "Returns the current scope in the Blockbench editor.",
  uriTemplate: "scope://{name}",
  arguments: [
    {
      name: "name",
      description: "The name of the scope.",
      complete: async (value: string) => {
        const scopes = Object.keys(globalThis);

        if (value.length > 0) {
          const filteredScopes = scopes.filter((scope) =>
            scope.includes(value)
          );

          return {
            values: filteredScopes,
          };
        }

        return {
          values: scopes,
        };
      },
    },
  ],
  async load({ name }) {
    const scopes = Object.keys(globalThis);

    let scope;

    if (name) {
      scope = scopes.find((scope) => scope === name);
    }

    return {
      text: JSON.stringify(
        scope ? [scope] : scopes
      ),
    };
  },
};

// @ts-expect-error Blockbench does not need authentication
server.addResourceTemplate(scopeResource);
*/
