/// <reference types="three" />
/// <reference types="blockbench-types" />

import { createResource } from "@/lib/factories";
import {
  isHytalePluginInstalled,
  isHytaleFormat,
  getHytaleFormatType,
  getHytaleBlockSize,
  getAttachmentCollections,
  getAttachmentPieces,
  validateNodeCount,
  getHytaleAnimationFPS,
  getCubeShadingMode,
  isCubeDoubleSided,
  type HytaleCube,
} from "@/lib/hytale";

/**
 * Register Hytale-specific resources.
 * These resources are only functional when the Hytale plugin is installed.
 */
export function registerHytaleResources() {
  // Only register if Hytale plugin is available
  if (!isHytalePluginInstalled()) {
    console.log("[MCP] Hytale plugin not detected, skipping Hytale resources registration");
    return;
  }

  console.log("[MCP] Hytale plugin detected, registering Hytale resources");

  // ============================================================================
  // Hytale Format Info Resource
  // ============================================================================

  createResource("hytale-format", {
    uriTemplate: "hytale://format",
    title: "Hytale Format Information",
    description:
      "Returns comprehensive information about the current Hytale format, including format type, block size, node limits, and feature support.",
    async listCallback() {
      if (!isHytaleFormat()) {
        return { resources: [] };
      }

      return {
        resources: [
          {
            uri: "hytale://format",
            name: `Hytale ${getHytaleFormatType()} format`,
            description: `Block size: ${getHytaleBlockSize()}, FPS: ${getHytaleAnimationFPS()}`,
            mimeType: "application/json",
          },
        ],
      };
    },
    async readCallback(uri) {
      if (!isHytaleFormat()) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                active: false,
                message: "No Hytale format project is currently active.",
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      const formatType = getHytaleFormatType();
      const blockSize = getHytaleBlockSize();
      const nodeValidation = validateNodeCount();

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              active: true,
              formatType,
              formatId: formatType === "character" ? "hytale_character" : "hytale_prop",
              blockSize,
              animationFPS: getHytaleAnimationFPS(),
              nodeCount: nodeValidation.count,
              maxNodes: nodeValidation.max,
              nodeCountValid: nodeValidation.valid,
              features: {
                boneRig: true,
                animationFiles: true,
                quaternionInterpolation: true,
                uvRotation: true,
                stretchCubes: true,
                attachments: true,
                quads: true,
                shadingModes: ["flat", "standard", "fullbright", "reflective"],
                doubleSided: true,
                visibilityKeyframes: true,
              },
            }),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ============================================================================
  // Hytale Attachments Resource
  // ============================================================================

  createResource("hytale-attachments", {
    uriTemplate: "hytale://attachments/{id}",
    title: "Hytale Attachments",
    description:
      "Returns information about attachment collections in the current Hytale project. Attachments are separate models that can be attached to bones.",
    async listCallback() {
      if (!isHytaleFormat()) {
        return { resources: [] };
      }

      const attachments = getAttachmentCollections();
      return {
        resources: attachments.map((a) => ({
          uri: `hytale://attachments/${a.uuid}`,
          name: a.name,
          description: `Attachment collection${a.texture ? " with texture" : ""}`,
          mimeType: "application/json",
        })),
      };
    },
    async readCallback(uri, { id }) {
      if (!isHytaleFormat()) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "No Hytale format project is currently active.",
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      const attachments = getAttachmentCollections();

      // If ID provided, find specific attachment
      if (id) {
        const attachment = attachments.find((a) => a.uuid === id || a.name === id);
        if (!attachment) {
          throw new Error(`Attachment "${id}" not found.`);
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                uuid: attachment.uuid,
                name: attachment.name,
                texture: attachment.texture ?? null,
                // @ts-ignore - children may exist
                elementCount: attachment.children?.length ?? 0,
                exportCodec: attachment.export_codec,
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Return all attachments
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              count: attachments.length,
              attachments: attachments.map((a) => ({
                uuid: a.uuid,
                name: a.name,
                texture: a.texture ?? null,
                // @ts-ignore - children may exist
                elementCount: a.children?.length ?? 0,
              })),
            }),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ============================================================================
  // Hytale Attachment Pieces Resource
  // ============================================================================

  createResource("hytale-pieces", {
    uriTemplate: "hytale://pieces/{id}",
    title: "Hytale Attachment Pieces",
    description:
      "Returns information about groups marked as attachment pieces. Attachment pieces connect to like-named bones in the main model.",
    async listCallback() {
      if (!isHytaleFormat()) {
        return { resources: [] };
      }

      const pieces = getAttachmentPieces();
      return {
        resources: pieces.map((p) => ({
          uri: `hytale://pieces/${p.uuid}`,
          name: p.name,
          description: "Attachment piece bone",
          mimeType: "application/json",
        })),
      };
    },
    async readCallback(uri, { id }) {
      if (!isHytaleFormat()) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "No Hytale format project is currently active.",
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      const pieces = getAttachmentPieces();

      // If ID provided, find specific piece
      if (id) {
        const piece = pieces.find((p) => p.uuid === id || p.name === id);
        if (!piece) {
          throw new Error(`Attachment piece "${id}" not found.`);
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                uuid: piece.uuid,
                name: piece.name,
                origin: piece.origin,
                rotation: piece.rotation,
                is_piece: true,
                // @ts-ignore - children property
                childCount: piece.children?.length ?? 0,
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Return all pieces
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              count: pieces.length,
              pieces: pieces.map((p) => ({
                uuid: p.uuid,
                name: p.name,
                origin: p.origin,
              })),
            }),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ============================================================================
  // Hytale Cubes Resource (with Hytale-specific properties)
  // ============================================================================

  createResource("hytale-cubes", {
    uriTemplate: "hytale://cubes/{id}",
    title: "Hytale Cubes",
    description:
      "Returns information about cubes with Hytale-specific properties (shading_mode, double_sided, stretch).",
    async listCallback() {
      if (!isHytaleFormat()) {
        return { resources: [] };
      }

      // @ts-ignore - Cube is globally available
      const cubes = Cube.all ?? [];
      return {
        resources: cubes.map((c: Cube) => ({
          uri: `hytale://cubes/${c.uuid}`,
          name: c.name,
          description: `Shading: ${getCubeShadingMode(c)}, Double-sided: ${isCubeDoubleSided(c)}`,
          mimeType: "application/json",
        })),
      };
    },
    async readCallback(uri, { id }) {
      if (!isHytaleFormat()) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "No Hytale format project is currently active.",
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      // @ts-ignore - Cube is globally available
      const cubes = Cube.all ?? [];

      // If ID provided, find specific cube
      if (id) {
        const cube = cubes.find((c: Cube) => c.uuid === id || c.name === id);
        if (!cube) {
          throw new Error(`Cube "${id}" not found.`);
        }

        const hytaleCube = cube as HytaleCube;
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                uuid: cube.uuid,
                name: cube.name,
                from: cube.from,
                to: cube.to,
                origin: cube.origin,
                rotation: cube.rotation,
                // @ts-ignore - stretch property
                stretch: cube.stretch ?? [1, 1, 1],
                shading_mode: getCubeShadingMode(cube),
                double_sided: isCubeDoubleSided(cube),
                autouv: cube.autouv,
                visibility: cube.visibility,
              }),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Return all cubes with Hytale properties
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              count: cubes.length,
              cubes: cubes.map((c: Cube) => ({
                uuid: c.uuid,
                name: c.name,
                shading_mode: getCubeShadingMode(c),
                double_sided: isCubeDoubleSided(c),
                // @ts-ignore - stretch property
                stretch: (c as HytaleCube).stretch ?? [1, 1, 1],
              })),
            }),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  console.log("[MCP] Hytale resources registered successfully");
}
