import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  type Camera,
  type Light,
  type Object3D,
  type Texture,
  type WebGPURenderer,
} from "three/webgpu";

import { applyPlacement, createRenderCamera } from "./camera";
import { boundingSphere, frameCamera, type IBounds } from "./framing";
import { LIGHTING_PRESETS, SHADOW_GROUND_OPACITY, type ILightingPreset, type ILightSpec } from "./lighting";
import type { RenderOptions } from "./options";

export { measureBounds } from "./bounds";
export { LIGHTING_PRESETS } from "./lighting";

const LIGHT_FACTORIES: Record<ILightSpec["type"], (spec: ILightSpec) => Light> = {
  directional: (spec) => new DirectionalLight(spec.color, spec.intensity),
  hemisphere: (spec) => new HemisphereLight(spec.color, spec.groundColor ?? 0x000000, spec.intensity),
  ambient: (spec) => new AmbientLight(spec.color, spec.intensity),
};

/** A staged scene whose camera and light rig can be moved per frame. */
export interface IStage {
  scene: Scene;
  camera: Camera;
  /** Moves the camera (and the light rig with it) to an azimuth in degrees. */
  aim(azimuth: number): void;
  dispose(): void;
}

/** Settings for {@link createStage}. */
export interface IStageOptions {
  model: Object3D;
  bounds: IBounds;
  width: number;
  height: number;
  /** Camera azimuth in degrees. */
  azimuth: number;
  elevation: number;
  camera: RenderOptions["camera"];
  lighting: RenderOptions["lighting"];
  renderer: WebGPURenderer;
}

/** An environment map and the function that frees everything used to build it. */
interface IEnvironment {
  texture: Texture | null;
  dispose(): void;
}

async function createEnvironment(options: IStageOptions, preset: ILightingPreset): Promise<IEnvironment> {
  if (preset.room <= 0) return { texture: null, dispose: () => undefined };
  const pmrem = new PMREMGenerator(options.renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  pmrem.dispose();
  room.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}

function createLight(spec: ILightSpec, radius: number, shadows: boolean): Light {
  const light = LIGHT_FACTORIES[spec.type](spec);
  const [x, y, z] = spec.direction ?? [0, 1, 0];
  light.position.set(x * radius * 4, y * radius * 4, z * radius * 4);
  if (!(light instanceof DirectionalLight) || spec.castShadow !== true || !shadows) return light;
  light.castShadow = true;
  const shadowCamera = light.shadow.camera;
  shadowCamera.left = -radius * 1.6;
  shadowCamera.right = radius * 1.6;
  shadowCamera.top = radius * 1.6;
  shadowCamera.bottom = -radius * 1.6;
  shadowCamera.near = radius * 0.5;
  shadowCamera.far = radius * 10;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = radius * 0.004;
  light.shadow.radius = 3;
  return light;
}

function createGround(options: IStageOptions, radius: number, floor: number): Mesh | null {
  if (options.lighting.ground === "none") return null;
  const material = options.lighting.ground === "shadow"
    ? new ShadowMaterial({ opacity: SHADOW_GROUND_OPACITY })
    : new MeshStandardMaterial({ color: new Color(options.lighting.groundColor), roughness: 1 });
  const ground = new Mesh(new PlaneGeometry(radius * 60, radius * 60), material);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floor;
  ground.receiveShadow = true;
  return ground;
}

/**
 * Builds the scene: model, preset lights on a rig that follows the camera, studio environment
 * lighting, and a shadow-catching or solid ground plane at the lowest point of the animation.
 */
export async function createStage(options: IStageOptions): Promise<IStage> {
  const preset = LIGHTING_PRESETS[options.lighting.preset];
  const { center, radius } = boundingSphere(options.bounds);
  const scene = new Scene();
  const shadows = options.lighting.shadows;

  options.model.traverse((object) => {
    object.castShadow = shadows;
    object.receiveShadow = shadows;
  });
  scene.add(options.model);

  const rig = new Group();
  rig.position.set(center[0], center[1], center[2]);
  const lights = preset.lights.map((spec) => createLight(spec, radius, shadows));
  lights.forEach((light) => {
    rig.add(light);
    if (light instanceof DirectionalLight) rig.add(light.target);
  });
  scene.add(rig);

  const environment = await createEnvironment(options, preset);
  scene.environment = environment.texture;
  scene.environmentIntensity = preset.room;

  const ground = createGround(options, radius, options.bounds.min[1]);
  if (ground !== null) scene.add(ground);

  const aspect = options.width / options.height;
  const camera = createRenderCamera(options.camera, aspect);

  const framing = {
    bounds: options.bounds,
    elevation: options.elevation,
    fov: options.camera.fov,
    aspect,
    padding: options.camera.padding,
    orthographic: options.camera.orthographic,
    fit: options.camera.fit === "auto" ? "box" : options.camera.fit,
  } as const;

  const aim = (azimuth: number): void => {
    applyPlacement(camera, frameCamera({ ...framing, azimuth }), aspect);
    rig.rotation.y = (-azimuth * Math.PI) / 180;
  };

  return {
    scene,
    camera,
    aim,
    dispose() {
      environment.dispose();
      lights.forEach((light) => light.dispose());
      ground?.geometry.dispose();
      [ground?.material].flat().forEach((material) => material?.dispose());
    },
  };
}
