/** A 3D vector as a plain tuple, so framing math stays free of three.js and easy to test. */
export type Vec3 = readonly [number, number, number];

/** Axis-aligned bounds of the model over every rendered pose. */
export interface IBounds {
  min: Vec3;
  max: Vec3;
  /**
   * World-space points outlining the model's actual shape, e.g. the corners of every part's own
   * bounding box across all poses. Box framing fits these instead of the eight overall corners,
   * which leaves far less empty frame around L-shaped or sprawling models.
   */
  points?: readonly Vec3[];
}

/** Inputs to {@link frameCamera}. */
export interface IFramingInput {
  bounds: IBounds;
  /** Degrees around the model; 0 views the front (-Z). */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Vertical field of view in degrees (perspective only). */
  fov: number;
  /** Output width / height. */
  aspect: number;
  padding: number;
  orthographic: boolean;
  /**
   * `sphere` frames identically from every angle (turntables). `box` fits the eight box corners
   * as seen from this angle, which is much tighter for flat or elongated scenes.
   */
  fit: "sphere" | "box";
}

/** Camera placement produced by {@link frameCamera}. */
export interface ICameraPlacement {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
  /** Half the visible height in world units (orthographic cameras only). */
  orthoHalfHeight: number;
}

const DEG = Math.PI / 180;

/** Center and bounding-sphere radius of a box. The sphere is used so every orbit angle frames identically. */
export function boundingSphere(bounds: IBounds): { center: Vec3; radius: number } {
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const half = bounds.max.map((value, axis) => (value - bounds.min[axis]!) / 2);
  const radius = Math.hypot(...half) || 0.5;
  return { center, radius };
}

/** Unit direction from the target toward the camera for the given angles. */
export function orbitDirection(azimuth: number, elevation: number): Vec3 {
  const az = azimuth * DEG;
  const el = elevation * DEG;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Eight corners of a box as offsets from its center. */
function cornerOffsets(bounds: IBounds, center: Vec3): Vec3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((bits): Vec3 => [
    (bits & 1 ? bounds.max[0] : bounds.min[0]) - center[0],
    (bits & 2 ? bounds.max[1] : bounds.min[1]) - center[1],
    (bits & 4 ? bounds.max[2] : bounds.min[2]) - center[2],
  ]);
}

/** Offsets from `center` of every point the frame must contain: the part outline when known, else the box corners. */
function fitOffsets(bounds: IBounds, center: Vec3): Vec3[] {
  if (bounds.points === undefined || bounds.points.length === 0) return cornerOffsets(bounds, center);
  return bounds.points.map((point): Vec3 => [point[0] - center[0], point[1] - center[1], point[2] - center[2]]);
}

/** Largest and smallest of many values without spreading them into arguments (which overflows the stack on large models). */
const extent = (values: readonly number[]): { min: number; max: number } =>
  values.reduce((range, value) => ({ min: Math.min(range.min, value), max: Math.max(range.max, value) }), { min: Infinity, max: -Infinity });

/**
 * Right, up, and toward-camera axes for a camera looking back along `direction` with world +Y up.
 */
function viewBasis(direction: Vec3): { right: Vec3; up: Vec3 } {
  const right = normalize([-direction[2], 0, direction[0]]);
  const up: Vec3 = [
    direction[1] * right[2] - direction[2] * right[1],
    direction[2] * right[0] - direction[0] * right[2],
    direction[0] * right[1] - direction[1] * right[0],
  ];
  return { right, up };
}

/**
 * The point to aim at: the middle of the model's outline as seen along `direction`. The box
 * center of an L-shaped model sits off its visible mass, which pushes the model to one side of
 * the frame; centering on the projected outline balances the shot.
 */
function outlineCenter(bounds: IBounds, center: Vec3, direction: Vec3): Vec3 {
  if (bounds.points === undefined || bounds.points.length === 0) return center;
  const { right, up } = viewBasis(direction);
  const offsets = fitOffsets(bounds, center);
  const x = extent(offsets.map((offset) => dot(offset, right)));
  const y = extent(offsets.map((offset) => dot(offset, up)));
  const dx = (x.min + x.max) / 2;
  const dy = (y.min + y.max) / 2;
  return [center[0] + right[0] * dx + up[0] * dy, center[1] + right[1] * dx + up[1] * dy, center[2] + right[2] * dx + up[2] * dy];
}

/** Distance and orthographic half height that fit the outline points (or box corners) as seen along `direction`. */
function fitBox(input: IFramingInput, center: Vec3, direction: Vec3, tanV: number, tanH: number): { distance: number; halfHeight: number } {
  const { right, up } = viewBasis(direction);
  const projected = fitOffsets(input.bounds, center).map((offset) => ({
    x: Math.abs(dot(offset, right)) * input.padding,
    y: Math.abs(dot(offset, up)) * input.padding,
    z: dot(offset, direction),
  }));
  const distance = extent(projected.map(({ x, y, z }) => z + Math.max(x / tanH, y / tanV))).max;
  const halfHeight = extent(projected.map(({ x, y }) => Math.max(y, x / input.aspect))).max;
  return { distance, halfHeight };
}

/**
 * Places a camera so the model fits the frame.
 *
 * Sphere fitting uses the narrower of the horizontal and vertical fields of view, so portrait and
 * landscape outputs both keep the whole model in frame from any orbit angle. Box fitting aims at
 * the middle of the model's outline and solves for the closest distance at which every outline
 * point (or bounding-box corner) is inside the frustum.
 */
export function frameCamera(input: IFramingInput): ICameraPlacement {
  const sphere = boundingSphere(input.bounds);
  const radius = sphere.radius;
  const direction = orbitDirection(input.azimuth, input.elevation);
  const center = input.fit === "box" ? outlineCenter(input.bounds, sphere.center, direction) : sphere.center;
  const fitRadius = radius * input.padding;
  const vHalf = (input.fov * DEG) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * input.aspect);
  const box = input.fit === "box" ? fitBox(input, center, direction, Math.tan(vHalf), Math.tan(hHalf)) : undefined;
  const perspectiveDistance = box?.distance ?? fitRadius / Math.sin(Math.min(vHalf, hHalf));
  const distance = input.orthographic ? fitRadius * 4 : perspectiveDistance;
  const sphereHalfHeight = input.aspect >= 1 ? fitRadius : fitRadius / input.aspect;
  const position: Vec3 = [
    center[0] + direction[0] * distance,
    center[1] + direction[1] * distance,
    center[2] + direction[2] * distance,
  ];
  return {
    position,
    target: center,
    near: Math.max(0.001, distance * 0.01),
    far: distance * 20 + fitRadius * 8,
    orthoHalfHeight: box?.halfHeight ?? sphereHalfHeight,
  };
}

/** Camera placement as a function of azimuth, for shots whose camera orbits. */
export type OrbitFramer = (azimuth: number) => ICameraPlacement;

const distanceBetween = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Builds a framer for a camera that sweeps `sweep` degrees starting at `startAzimuth`.
 *
 * Sphere fitting is already angle-independent. Box fitting is tighter but changes with the angle,
 * which would make an orbiting camera zoom in and out. So box fits are sampled across the whole sweep
 * and the worst-case distance and orthographic size are held for every frame: the shot stays as
 * tight as the widest angle allows, at a constant distance. Orbits fit the overall box corners
 * around a fixed pivot; only stills use the part outline and re-centering.
 */
export function createOrbitFramer(input: Omit<IFramingInput, "azimuth">, startAzimuth: number, sweep: number): OrbitFramer {
  if (sweep === 0 || input.fit === "sphere") return (azimuth) => frameCamera({ ...input, azimuth });
  // An orbit keeps one fixed pivot: re-centering on each angle's outline would make the camera sway.
  const box: IBounds = { min: input.bounds.min, max: input.bounds.max };
  const place = (azimuth: number): ICameraPlacement => frameCamera({ ...input, bounds: box, azimuth });

  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 5) + 1);
  const samples = Array.from({ length: steps }, (_, i) => place(startAzimuth + (sweep * i) / (steps - 1)));
  const distance = Math.max(...samples.map((sample) => distanceBetween(sample.position, sample.target)));
  const halfHeight = Math.max(...samples.map((sample) => sample.orthoHalfHeight));

  return (azimuth) => {
    const placement = place(azimuth);
    const direction = orbitDirection(azimuth, input.elevation);
    const cameraDistance = input.orthographic ? distanceBetween(placement.position, placement.target) : distance;
    const position: Vec3 = [
      placement.target[0] + direction[0] * cameraDistance,
      placement.target[1] + direction[1] * cameraDistance,
      placement.target[2] + direction[2] * cameraDistance,
    ];
    return {
      ...placement,
      position,
      near: Math.max(0.001, cameraDistance * 0.01),
      far: Math.max(placement.far, cameraDistance * 20),
      orthoHalfHeight: halfHeight,
    };
  };
}
