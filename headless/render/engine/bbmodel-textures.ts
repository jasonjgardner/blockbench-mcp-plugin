import type { Texture } from "three";
import type { BBModelDocument } from "three-blockbench";

/**
 * three-blockbench 0.1.0 texture workarounds shared by the Node loader and the browser path
 * tracer. Free of Node APIs and of `three/webgpu`, so both runtimes apply identical fixes.
 */

/** Image pixels per Blockbench UV unit for a texture loaded by three-blockbench. */
export function texelsPerUvUnit(texture: Texture, document: BBModelDocument): number | undefined {
  const data = texture.userData["blockbenchTexture"] as { uv_width?: number } | undefined;
  const image = texture.image as { width?: unknown } | undefined;
  const uvWidth = data?.uv_width ?? document.resolution?.width;
  if (data === undefined || typeof image?.width !== "number" || uvWidth === undefined || uvWidth <= 0) return undefined;
  return image.width / uvWidth;
}

/**
 * Animated-texture frame count the way Blockbench computes it: from the image aspect ratio against
 * the UV aspect ratio. A 16x64 strip with 16x16 UVs has 4 frames; a 2048x2048 HD atlas with 16x16
 * UVs has 1.
 */
export function blockbenchFrameCount(image: { width: number; height: number }, uvWidth: number, uvHeight: number): number {
  if (image.width <= 0 || uvHeight <= 0) return 1;
  return Math.max(1, Math.floor((image.height * uvWidth) / (image.width * uvHeight) + 1e-9));
}

/**
 * Resets each texture to frame 0 of its correct frame count.
 *
 * three-blockbench 0.1.0 counts frames as `image.height / uv_height`, which treats any texture
 * whose resolution exceeds its UV size (every HD atlas) as a many-frame animation. Each face then
 * samples a thin strip, rendering as streaks. Frames are also not advanced during renders, so
 * animated textures hold their first frame.
 */
export function fixTextureFrames(textures: Iterable<Texture>, document: BBModelDocument): void {
  [...textures].forEach((texture) => {
    const data = texture.userData["blockbenchTexture"] as { uv_width?: number; uv_height?: number } | undefined;
    const image = texture.image as { width?: unknown; height?: unknown } | undefined;
    if (data === undefined || typeof image?.width !== "number" || typeof image.height !== "number") return;
    const frames = blockbenchFrameCount(
      { width: image.width, height: image.height },
      data.uv_width ?? document.resolution?.width ?? image.width,
      data.uv_height ?? document.resolution?.height ?? image.height,
    );
    texture.repeat.y = 1 / frames;
    texture.offset.y = 1 - 1 / frames;
  });
}

/**
 * Disables Blockbench texture layers so the loader uses each texture's flattened `source` image.
 * Layer compositing needs a browser 2D canvas, which does not exist in headless Node; the path
 * tracer flattens too so both backends sample the same pixels.
 */
export function withFlattenedTextures(document: BBModelDocument): BBModelDocument {
  return { ...document, textures: document.textures.map((texture) => ({ ...texture, layers_enabled: false })) };
}
