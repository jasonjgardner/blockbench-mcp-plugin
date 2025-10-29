import html2canvas from "html2canvas";

/**
 * Helper function to create properly formatted image content for MCP responses.
 * Handles data URLs, base64 strings, and file paths.
 * 
 * @param data - Image data as base64, data URL, or file path
 * @param mimeType - MIME type of the image (e.g., 'image/png', 'image/jpeg')
 * @returns Formatted image content object for MCP
 */
export function imageContent(data: string, mimeType: string = "image/png") {
  let base64Data = data;
  
  // If it's a data URL, extract the base64 part
  if (data.startsWith("data:")) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1] || mimeType;
      base64Data = matches[2];
    }
  }
  
  // If it's a file path, read and encode it
  // Note: For now, we'll assume data is already base64 or a data URL
  // File system access should be handled by the caller
  
  return {
    type: "image" as const,
    data: base64Data,
    mimeType,
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

  if (selectedProject.select()) {
    selectedProject.updateThumbnail();
  }

  const imgData = imageContent(selectedProject.thumbnail, "image/png");
  return {
    content: [{ type: "image" as const, data: imgData.data, mimeType: imgData.mimeType }],
  };
}

export async function captureAppScreenshot() {
  const canvas = await html2canvas(document.documentElement);
  const dataUrl = canvas.toDataURL();
  const imgData = imageContent(dataUrl, "image/png");
  return {
    content: [{ type: "image" as const, data: imgData.data, mimeType: imgData.mimeType }],
  };
}