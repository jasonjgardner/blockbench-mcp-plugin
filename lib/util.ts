import html2canvas from "html2canvas";
import { imageContent } from "fastmcp";

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

  return imageContent({ url: selectedProject.thumbnail });
}

export async function captureAppScreenshot() {
  const canvas = await html2canvas(document.documentElement);
  return await imageContent({ url: canvas.toDataURL() });
}