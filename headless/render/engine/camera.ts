import { OrthographicCamera, PerspectiveCamera } from "three";

import type { ICameraPlacement } from "./framing";
import type { RenderOptions } from "./options";

/** Either projection bb-render renders with. */
export type RenderCamera = PerspectiveCamera | OrthographicCamera;

/**
 * Creates the camera for `camera.orthographic`; {@link applyPlacement} sets its real frustum.
 *
 * Shared by the WebGPU stage and the browser path tracer. Imports plain `three`, whose camera
 * classes are the same ones `three/webgpu` re-exports.
 */
export function createRenderCamera(camera: RenderOptions["camera"], aspect: number): RenderCamera {
  return camera.orthographic
    ? new OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 100)
    : new PerspectiveCamera(camera.fov, aspect, 0.01, 100);
}

/** Moves a camera to a framing placement and refreshes its projection, so both backends frame every azimuth identically. */
export function applyPlacement(camera: RenderCamera, placement: ICameraPlacement, aspect: number): void {
  camera.position.set(...placement.position);
  camera.lookAt(...placement.target);
  if (camera instanceof OrthographicCamera) {
    const half = placement.orthoHalfHeight;
    Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
  }
  Object.assign(camera, { near: placement.near, far: placement.far });
  camera.updateProjectionMatrix();
}
