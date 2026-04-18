/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createResource } from "@/lib/factories";
import { findByResourceId, makeResourceUri } from "@/lib/resourceUri";

// Register projects resource using the factory pattern
createResource("projects", {
  uriTemplate: "projects://{id}",
  title: "Blockbench Projects",
  description:
    "Returns information about available projects in Blockbench. List URIs use the project's slugified name (e.g. `projects://my-character`) when unique, or `projects://<slug>~<uuid-prefix>` on collision. The read side also accepts the raw UUID or exact name. Use without an ID to list all projects.",
  async listCallback() {
    const projects = ModelProject.all;
    if (!projects || projects.length === 0) {
      return { resources: [] };
    }
    return {
      resources: projects.map((project) => ({
        uri: makeResourceUri("projects", project, projects),
        name: project.name || project.uuid,
        description: `${project.format?.name ?? "Unknown format"} project${project.saved ? "" : " (unsaved)"}`,
        mimeType: "application/json",
      })),
    };
  },
  async readCallback(uri, { id }) {
    const projects = ModelProject.all;

    if (!projects || projects.length === 0) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ projects: [], count: 0 }),
            mimeType: "application/json",
          },
        ],
      };
    }

    // Helper to extract project info
    const getProjectInfo = (project: ModelProject) => ({
      uuid: project.uuid,
      name: project.name,
      selected: project.selected,
      saved: project.saved,
      format: project.format?.id ?? null,
      formatName: project.format?.name ?? null,
      boxUv: project.box_uv,
      textureWidth: project.texture_width,
      textureHeight: project.texture_height,
      savePath: project.save_path || null,
      exportPath: project.export_path || null,
      elementCount: project.elements?.length ?? 0,
      groupCount: project.groups?.length ?? 0,
      textureCount: project.textures?.length ?? 0,
      animationCount: project.animations?.length ?? 0,
      modelIdentifier: project.model_identifier || null,
      geometryName: project.geometry_name || null,
    });

    // If ID provided, find specific project
    if (id) {
      const project = findByResourceId(projects, id);

      if (!project) {
        throw new Error(`Project with ID "${id}" not found.`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(getProjectInfo(project)),
            mimeType: "application/json",
          },
        ],
      };
    }

    // Return all projects
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            projects: projects.map(getProjectInfo),
            count: projects.length,
            activeProject: Project ? Project.uuid : null,
          }),
          mimeType: "application/json",
        },
      ],
    };
  },
});

createResource("nodes", {
  uriTemplate: "nodes://{id}",
  title: "Blockbench Nodes",
  description:
    "Returns the current nodes in the Blockbench editor. List URIs use the node's slugified name (e.g. `nodes://head`) when unique, with a `~<uuid-prefix>` suffix added to disambiguate collisions. Reads also accept the raw UUID or exact name.",
  async listCallback() {
    if (!Project?.nodes_3d) {
      return { resources: [] };
    }
    const nodes = Object.values(Project.nodes_3d);
    return {
      resources: nodes.map((node) => ({
        uri: makeResourceUri("nodes", node, nodes),
        name: node.name || node.uuid,
        description: `3D node in current project`,
        mimeType: "application/json",
      })),
    };
  },
  async readCallback(uri, { id }) {
    if (!Project?.nodes_3d) {
      throw new Error("No nodes found in the Blockbench editor.");
    }

    const nodes = Object.values(Project.nodes_3d);
    const node =
      (id ? Project.nodes_3d[id] : undefined) ?? findByResourceId(nodes, id);

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
          mimeType: "application/json",
        },
      ],
    };
  },
});

createResource("textures", {
  uriTemplate: "textures://{id}",
  title: "Blockbench Textures",
  description:
    "Returns information about textures in the current Blockbench project. List URIs use the texture's slugified name (e.g. `textures://skin`) when unique, with a `~<uuid-prefix>` suffix added on collision. Reads also accept the raw UUID, short numeric `id`, or exact name.",
  async listCallback() {
    const textures = Project?.textures ?? [];
    if (textures.length === 0) {
      return { resources: [] };
    }
    return {
      resources: textures.map((texture) => ({
        uri: makeResourceUri("textures", texture, textures),
        name: texture.name || texture.uuid,
        mimeType: "application/json",
        description: texture.path ? `Texture from ${texture.path}` : "Embedded texture",
      })),
    };
  },
  async readCallback(uri, { id }) {
    const textures = Project?.textures ?? [];

    if (textures.length === 0) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ textures: [], count: 0 }),
            mimeType: "application/json",
          },
        ],
      };
    }

    // Helper to extract texture info
    const getTextureInfo = (texture: Texture) => ({
      uuid: texture.uuid,
      name: texture.name,
      id: texture.id,
      width: texture.width,
      height: texture.height,
      frameCount: texture.frameCount,
      // @ts-ignore - ratio property exists at runtime
      ratio: texture.ratio,
      path: texture.path || null,
      folder: texture.folder || null,
      namespace: texture.namespace || null,
      particle: texture.particle ?? false,
      render_mode: texture.render_mode || "default",
      render_sides: texture.render_sides || "auto",
      visible: texture.visible ?? true,
      saved: texture.saved ?? false,
      selected: texture.selected ?? false,
      source: texture.source || null,
    });

    // If ID provided, find specific texture
    if (id) {
      const texture =
        textures.find((t) => t.id === id) ?? findByResourceId(textures, id);

      if (!texture) {
        throw new Error(`Texture with ID "${id}" not found.`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(getTextureInfo(texture)),
            mimeType: "application/json",
          },
        ],
      };
    }

    // Return all textures
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            textures: textures.map(getTextureInfo),
            count: textures.length,
          }),
          mimeType: "application/json",
        },
      ],
    };
  },
});

if (Plugins.installed.some((p: { id: string }) => p.id === "reference_models")) {
  createResource("reference_models", {
    uriTemplate: "reference_models://{id}",
    title: "Reference Models",
    description:
      "Returns information about reference models in the current Blockbench project. Requires the Reference Models plugin. List URIs use the slugified name (e.g. `reference_models://turntable`) when unique, with a `~<uuid-prefix>` suffix on collision. Reads also accept the raw UUID or exact name.",
    async listCallback() {
      const elements = Outliner?.elements ?? [];
      const referenceModels = elements.filter(
        (e) => e.type === "reference_model"
      );
      if (referenceModels.length === 0) {
        return { resources: [] };
      }
      return {
        resources: referenceModels.map((model) => ({
          uri: makeResourceUri("reference_models", model, referenceModels),
          name: model.name || model.uuid,
          description: (model as { path?: string }).path
            ? `Reference model from ${(model as { path?: string }).path}`
            : "Reference model",
          mimeType: "application/json",
        })),
      };
    },
    async readCallback(uri, { id }) {
      const elements = Outliner?.elements ?? [];
      const referenceModels = elements.filter(
        (e) => e.type === "reference_model"
      );

      if (referenceModels.length === 0) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ referenceModels: [], count: 0 }),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Normalize Vector3-like values to [number, number, number] arrays
      const normalizeVec3 = (
        value: unknown,
        defaultValue: [number, number, number]
      ): [number, number, number] => {
        if (!value) {
          return defaultValue;
        }
        if (Array.isArray(value) && value.length >= 3) {
          return [Number(value[0]), Number(value[1]), Number(value[2])];
        }
        if (
          typeof value === "object" &&
          "x" in value &&
          "y" in value &&
          "z" in value
        ) {
          const v = value as { x: number; y: number; z: number };
          return [Number(v.x), Number(v.y), Number(v.z)];
        }
        return defaultValue;
      };

      // Helper to extract reference model info
      const getReferenceModelInfo = (model: OutlinerElement) => {
        const refModel = model as OutlinerElement & {
          path?: string;
          origin?: unknown;
          rotation?: unknown;
          scale?: unknown;
          visibility?: boolean;
        };
        return {
          uuid: refModel.uuid,
          name: refModel.name,
          path: refModel.path || null,
          origin: normalizeVec3(refModel.origin, [0, 0, 0]),
          rotation: normalizeVec3(refModel.rotation, [0, 0, 0]),
          scale: normalizeVec3(refModel.scale, [1, 1, 1]),
          visibility: refModel.visibility ?? true,
        };
      };

      // If ID provided, find specific reference model
      if (id) {
        const model = findByResourceId(referenceModels, id);

        if (!model) {
          throw new Error(`Reference model with ID "${id}" not found.`);
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(getReferenceModelInfo(model)),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Return all reference models
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              referenceModels: referenceModels.map(getReferenceModelInfo),
              count: referenceModels.length,
            }),
            mimeType: "application/json",
          },
        ],
      };
    },
  });
}