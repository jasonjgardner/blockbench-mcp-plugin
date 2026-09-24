import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BBModelLoader, type BBModelDocument } from "three-blockbench";
import { DataTexture, Mesh, RGBAFormat, type AnimationClip, type Object3D, type Texture } from "three/webgpu";

import { fixTextureFrames, texelsPerUvUnit, withFlattenedTextures } from "./bbmodel-textures";
import { decodePng, flipRows } from "./png";
import { blockbenchClipTiming, createPoser, type IPoser } from "./poser";
import { filterSceneTextures, type TextureFilterMode } from "./texture-filter";
import type { IClipTiming } from "./timeline";
import { unskinRigidMeshes } from "./unskin";

export { blockbenchFrameCount } from "./bbmodel-textures";
export { findClip } from "./clips";

/** A model ready to place in a scene, with its animation clips and a way to pose them. */
export interface ILoadedModel {
  root: Object3D;
  clips: readonly AnimationClip[];
  warnings: readonly string[];
  /** Timing facts for a clip. */
  timing(clip: AnimationClip): IClipTiming;
  /** Starts `clip` and returns a poser for deterministic, clock-free sampling. */
  play(clip: AnimationClip): IPoser;
  dispose(): void;
}

/** Settings for {@link loadModel}. */
export interface ILoadModelOptions {
  /** Texture sampling policy; see {@link filterSceneTextures}. */
  textureFilter: TextureFilterMode;
}

/** Frame rate used to sample Blockbench curves; stills only need the exact pose, so this just keeps them smooth. */
const SAMPLE_RATE = 120;

/**
 * Decodes a data URL or file URL into an RGBA DataTexture, since Node has no Image element.
 *
 * Rows are flipped so the image's top row lands at v = 1. three-blockbench maps Blockbench's
 * top-down UVs with `v = 1 - y / height`, and a DataTexture uploads its first row at v = 0, so an
 * unflipped decode samples every face upside down (a palette texture shows its bottom rows).
 */
export async function decodeTexture(url: string): Promise<Texture> {
  const source = url.startsWith("data:")
    ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
    : await readFile(url.startsWith("file:") ? fileURLToPath(url) : url);
  const image = decodePng(source);
  const texture = new DataTexture(flipRows(image), image.width, image.height, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** Loads a Blockbench `.bbmodel` through three-blockbench into three.js objects. */
export async function loadModel(path: string, options: ILoadModelOptions): Promise<ILoadedModel> {
  const document = JSON.parse(await readFile(path, "utf8")) as BBModelDocument;
  const loader = new BBModelLoader(undefined, {
    animationSampleRate: SAMPLE_RATE,
    maxAnimationSampleRate: SAMPLE_RATE,
    textureFactory: ({ url }) => decodeTexture(url),
  });
  const model = await loader.parseAsync(withFlattenedTextures(document), `${pathToFileURL(dirname(path)).href}/`);
  fixTextureFrames(model.textures.values(), document);
  unskinRigidMeshes(model.scene);
  filterSceneTextures(model.scene, options.textureFilter, (texture) => texelsPerUvUnit(texture, document), false);

  return {
    root: model.scene,
    clips: model.animations,
    warnings: model.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    timing: blockbenchClipTiming,
    play(clip) {
      const mixer = model.createMixer();
      return createPoser(mixer, model.createAction(mixer, clip));
    },
    dispose() {
      model.dispose();
      model.scene.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
    },
  };
}

/**
 * Fails fast with an absolute path when the input model is missing, before the GPU starts.
 *
 * @throws Error naming the resolved path, which shows relative-path mistakes at a glance.
 */
export async function assertInputExists(path: string): Promise<void> {
  const found = await stat(path).then((info) => info.isFile(), () => false);
  if (!found) throw new Error(`Input model not found: ${resolve(path)}`);
}
