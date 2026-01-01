/// <reference types="three" />
/// <reference types="blockbench-types" />
import { createResource } from "@/lib/factories";

// Register projects resource using the factory pattern
createResource("projects", {
  uriTemplate: "projects://{id}",
  title: "Blockbench Projects",
  description:
    "Returns information about available projects in Blockbench. Use without an ID to list all projects, or provide a project UUID/name to get details about a specific project.",
  async listCallback() {
    const projects = ModelProject.all;
    if (!projects || projects.length === 0) {
      return { resources: [] };
    }
    return {
      resources: projects.map((project) => ({
        uri: `projects://${project.uuid}`,
        name: project.name || project.uuid,
        description: `${project.format?.name ?? "Unknown format"} project${project.saved ? "" : " (unsaved)"}`,
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
      const project = projects.find(
        (p) => p.uuid === id || p.name === id
      );

      if (!project) {
        throw new Error(`Project with ID "${id}" not found.`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(getProjectInfo(project)),
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
        },
      ],
    };
  },
});

createResource("nodes", {
  uriTemplate: "nodes://{id}",
  title: "Blockbench Nodes",
  description: "Returns the current nodes in the Blockbench editor.",
  async listCallback() {
    if (!Project?.nodes_3d) {
      return { resources: [] };
    }
    const nodes = Object.values(Project.nodes_3d);
    return {
      resources: nodes.map((node) => ({
        uri: `nodes://${node.uuid}`,
        name: node.name || node.uuid,
        description: `3D node in current project`,
      })),
    };
  },
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
