import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from "three";

/** How textures are sampled: crisp pixel art, smooth high-resolution, or chosen per texture. */
export type TextureFilterMode = "auto" | "nearest" | "smooth";

/** Texels per Blockbench UV unit at or above which a texture counts as high resolution. */
export const HD_TEXELS_PER_UV_UNIT = 4;

/** Image width in pixels at or above which a glTF/USD texture counts as high resolution. */
export const HD_MIN_PIXELS = 256;

/** Facts about one texture that decide its filter. */
export interface ITextureFacts {
  /** Image width in pixels. */
  pixels: number;
  /** Image pixels per Blockbench UV unit, when the texture comes from a .bbmodel. */
  texelsPerUvUnit?: number;
}

/**
 * Decides whether a texture should be sampled smoothly.
 *
 * Pixel-art textures map about one texel per UV unit and must stay nearest-filtered. HD atlases
 * (2048 px over 16 UV units is 128 texels per unit) shrink to a few screen pixels per face and
 * alias into streaks without mipmaps, so `auto` switches them to trilinear filtering.
 */
export function wantsSmooth(mode: TextureFilterMode, facts: ITextureFacts): boolean {
  if (mode !== "auto") return mode === "smooth";
  if (facts.texelsPerUvUnit !== undefined) return facts.texelsPerUvUnit >= HD_TEXELS_PER_UV_UNIT;
  return facts.pixels >= HD_MIN_PIXELS;
}

const TEXTURE_SLOTS = ["map", "emissiveMap", "normalMap", "bumpMap", "roughnessMap", "metalnessMap", "aoMap", "alphaMap"] as const;

/** Every distinct texture referenced by materials under `root`. */
export function sceneTextures(root: Object3D): Texture[] {
  const found = new Set<Texture>();
  root.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    if (material === undefined) return;
    [material].flat().forEach((entry) => {
      const slots = entry as unknown as Partial<Record<(typeof TEXTURE_SLOTS)[number], Texture | null>>;
      TEXTURE_SLOTS.map((slot) => slots[slot]).forEach((texture) => {
        if (texture !== null && texture !== undefined) found.add(texture);
      });
    });
  });
  return [...found];
}

/** Width of a texture's image, or 0 when it has none yet. */
const imageWidth = (texture: Texture): number => {
  const image = texture.image as { width?: unknown } | null | undefined;
  return typeof image?.width === "number" ? image.width : 0;
};

/**
 * Applies nearest or trilinear-with-anisotropy filtering to every texture under `root`.
 *
 * `texelsPerUvUnit` reports Blockbench texel density when known. In `auto` mode, textures that are
 * not high resolution keep their loader's filter (Blockbench's per-texture interpolation setting)
 * unless `forceNearestOnLowRes` asks for pixel-art sampling, as glTF and USD loaders need.
 */
export function filterSceneTextures(
  root: Object3D,
  mode: TextureFilterMode,
  texelsPerUvUnit: (texture: Texture) => number | undefined,
  forceNearestOnLowRes: boolean,
): void {
  sceneTextures(root).forEach((texture) => {
    const density = texelsPerUvUnit(texture);
    const facts: ITextureFacts = density === undefined ? { pixels: imageWidth(texture) } : { pixels: imageWidth(texture), texelsPerUvUnit: density };
    const smooth = wantsSmooth(mode, facts);
    if (!smooth && mode === "auto" && !forceNearestOnLowRes) return;
    texture.magFilter = smooth ? LinearFilter : NearestFilter;
    texture.minFilter = smooth ? LinearMipmapLinearFilter : NearestFilter;
    texture.generateMipmaps = smooth;
    texture.anisotropy = smooth ? 8 : 1;
    texture.needsUpdate = true;
  });
}
