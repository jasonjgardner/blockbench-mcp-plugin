/**
 * Helper function to create properly formatted image content for MCP responses.
 * Handles data URLs, base64 strings, and objects with url property.
 *
 * @param dataOrOptions - Image data as base64/data URL string, or object with { url: string }
 * @param mimeType - MIME type of the image (e.g., 'image/png', 'image/jpeg')
 * @returns Formatted MCP tool result with image content
 */
export function imageContent(
  dataOrOptions: string | { url: string },
  mimeType: string = "image/png"
): { content: Array<{ type: "image"; data: string; mimeType: string }> } {
  // Handle object with url property
  const data = typeof dataOrOptions === "string" ? dataOrOptions : dataOrOptions.url;
  let base64Data = data;

  // If it's a data URL, extract the base64 part
  if (data.startsWith("data:")) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1] || mimeType;
      base64Data = matches[2];
    }
  }

  return {
    content: [
      {
        type: "image" as const,
        data: base64Data,
        mimeType,
      },
    ],
  };
}

export function fixCircularReferences<
  T extends Record<string, any>,
  K extends keyof T,
  V extends T[K]
>(o: T): (k: K, v: V) => V | string {
  const weirdTypes = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    BigInt64Array,
    BigUint64Array,
    //Float16Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    // SharedArrayBuffer,
    DataView,
  ];

  const defs = new Map();

  return function (k: K, v: V): V | string {
    if (k && (v as unknown) === o)
      return "[" + (k as string) + " is the same as original object]";
    if (v === undefined) return undefined as V;
    if (v === null) return null as V;
    const weirdType = weirdTypes.find((t) => (v as unknown) instanceof t);
    if (weirdType) return weirdType.toString();
    if (typeof v == "function") {
      return v.toString();
    }
    if (v && typeof v == "object") {
      const def = defs.get(v);
      if (def)
        return "[" + (k as string) + " is the same as " + (def as string) + "]";
      defs.set(v, k);
    }
    return v;
  };
}

export function getProjectTexture(id: string): Texture | null {
  const texture = (Project?.textures ?? Texture.all).find(
    ({ id: textureId, name, uuid }) =>
      textureId === id || name === id || uuid === id
  );

  return texture || null;
}

// ============================================================================
// Lookup Helpers with Actionable Error Messages
// ============================================================================

/**
 * Finds a group/bone by name and throws an actionable error if not found.
 * @param name - The name of the group/bone to find
 * @returns The found Group
 * @throws Error with suggestion to use list_outline
 */
export function findGroupOrThrow(name: string): Group {
  // @ts-ignore - Group is globally available in Blockbench
  const group = Group.all.find((g: Group) => g.name === name);
  if (!group) {
    throw new Error(
      `Bone/group "${name}" not found. Use the list_outline tool to see available groups and bones.`
    );
  }
  return group;
}

/**
 * Finds a mesh by ID or name and throws an actionable error if not found.
 * @param id - The UUID or name of the mesh to find
 * @returns The found Mesh
 * @throws Error with suggestion to use list_outline
 */
export function findMeshOrThrow(id: string): Mesh {
  // @ts-ignore - Mesh is globally available in Blockbench
  const mesh = Mesh.all.find((m: Mesh) => m.uuid === id || m.name === id);
  if (!mesh) {
    throw new Error(
      `Mesh "${id}" not found. Use the list_outline tool to see available meshes.`
    );
  }
  return mesh;
}

/**
 * Finds an element (cube, mesh, group) by ID or name and throws an actionable error if not found.
 * @param id - The UUID or name of the element to find
 * @returns The found OutlinerElement
 * @throws Error with suggestion to use list_outline
 */
export function findElementOrThrow(id: string): OutlinerElement {
  const element = Outliner.elements.find(
    (el: OutlinerElement) => el.uuid === id || el.name === id
  ) || Group.all.find((g: Group) => g.uuid === id || g.name === id);
  if (!element) {
    throw new Error(
      `Element "${id}" not found. Use the list_outline tool to see available elements.`
    );
  }
  return element;
}

/**
 * Finds a texture by ID, name, or UUID and throws an actionable error if not found.
 * @param id - The ID, name, or UUID of the texture to find
 * @returns The found Texture
 * @throws Error with suggestion to use list_textures
 */
export function findTextureOrThrow(id: string): Texture {
  const texture = getProjectTexture(id);
  if (!texture) {
    throw new Error(
      `Texture "${id}" not found. Use the list_textures tool to see available textures.`
    );
  }
  return texture;
}

/**
 * Helper to find a TextureGroup by name or UUID
 */
export function findTextureGroupOrThrow(id: string): TextureGroup {
  // @ts-ignore - TextureGroup is globally available in Blockbench
  const group = TextureGroup.all.find(
    (g: TextureGroup) => g.uuid === id || g.name === id
  );
  if (!group) {
    throw new Error(
      `Material/texture group "${id}" not found. Use the list_materials tool to see available materials.`
    );
  }
  return group;
}

/**
 * Helper to get texture info for a PBR channel
 */
export function getChannelTextureInfo(textures: Texture[], channel: string) {
  const tex = textures.find((t: Texture) => t.pbr_channel === channel);
  return tex
    ? { name: tex.name, uuid: tex.uuid, hasTexture: true }
    : { hasTexture: false };
}

/**
 * Gets a mesh by ID or returns the selected mesh if no ID provided.
 * Throws an actionable error if no mesh is found.
 * @param meshId - Optional mesh UUID or name
 * @returns The found or selected Mesh
 * @throws Error with suggestion to use list_outline
 */
export function getMeshOrSelected(meshId?: string): Mesh {
  if (meshId) {
    return findMeshOrThrow(meshId);
  }
  // @ts-ignore - Mesh is globally available in Blockbench
  const selected = Mesh.selected[0];
  if (!selected) {
    throw new Error(
      "No mesh selected and no mesh_id provided. Select a mesh or provide a mesh_id. Use the list_outline tool to see available meshes."
    );
  }
  return selected;
}

/**
 * Captures a screenshot of the 3D preview canvas.
 * Uses Blockbench's native rendering pipeline for accurate capture.
 */
export function captureScreenshot(project?: string) {
  let selectedProject = Project;

  if (!selectedProject || project !== undefined) {
    selectedProject = ModelProject.all.find(
      (p) => p.name === project || p.uuid === project || p.selected
    );
  }

  if (!selectedProject) {
    throw new Error("No project found in the Blockbench editor.");
  }

  // Select the project if needed
  if (!selectedProject.selected) {
    selectedProject.select();
  }

  // @ts-ignore - Preview is globally available in Blockbench
  const preview = Preview.selected;
  if (!preview) {
    throw new Error("No preview available for the selected project.");
  }

  // Capture the preview canvas using Blockbench's native approach
  // Canvas.withoutGizmos temporarily hides gizmos, executes the callback, then restores them
  let dataUrl: string | undefined;
  // @ts-ignore - Canvas is globally available in Blockbench
  Canvas.withoutGizmos(() => {
    preview.render();
    dataUrl = preview.canvas.toDataURL();
  });

  if (!dataUrl) {
    throw new Error("Failed to capture preview screenshot.");
  }

  return imageContent(dataUrl, "image/png");
}

/**
 * Captures a screenshot of the entire Blockbench application window.
 * Uses Electron's native capturePage API through Blockbench's Screencam.
 * Only available when running as a desktop application.
 */
export async function captureAppScreenshot(): Promise<ReturnType<typeof imageContent>> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Add a timeout in case the callback is never called
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("App screenshot timed out after 5 seconds."));
      }
    }, 5000);

    // Use Blockbench's native Screencam.fullScreen which uses Electron's capturePage
    // @ts-ignore - Screencam is globally available in Blockbench
    Screencam.fullScreen({}, (dataUrl: string) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        if (dataUrl) {
          resolve(imageContent(dataUrl, "image/png"));
        } else {
          reject(
            new Error("Failed to capture app screenshot - no data returned.")
          );
        }
      }
    });
  });
}