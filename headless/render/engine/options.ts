/**
 * Render settings for the still-frame renderer.
 *
 * Hand-validated instead of using zod so this Node-side runtime installs three packages and nothing
 * else. The MCP tools validate their own inputs; this layer guards the CLI and supplies defaults.
 */

/** Named camera angles. Azimuth 0 looks at the model's front (-Z for Blockbench projects). */
export const CAMERA_VIEWS = {
  front: { azimuth: 0, elevation: 8 },
  back: { azimuth: 180, elevation: 8 },
  left: { azimuth: -90, elevation: 8 },
  right: { azimuth: 90, elevation: 8 },
  "three-quarter": { azimuth: 35, elevation: 20 },
  iso: { azimuth: 45, elevation: 35.264 },
  top: { azimuth: 0, elevation: 89.9 },
} as const satisfies Record<string, { azimuth: number; elevation: number }>;

/** A key of {@link CAMERA_VIEWS}. */
export type CameraView = keyof typeof CAMERA_VIEWS;

/** Largest output width or height in pixels. */
export const MAX_DIMENSION = 8192;

/** Tone mapping operators the output pass supports. */
export const TONE_MAPPING_NAMES = ["agx", "aces", "neutral", "linear", "none"] as const;

/** Fully resolved render settings with all defaults applied. */
export interface IRenderSettings {
  input: string;
  output: string;
  width: number;
  height: number;
  /** Render at this multiple of the output size and box-filter down. */
  supersample: 1 | 2;
  /** Hex color, or "transparent". */
  background: string;
  toneMapping: (typeof TONE_MAPPING_NAMES)[number];
  exposure: number;
  textureFilter: "auto" | "nearest" | "smooth";
  camera: {
    view: CameraView;
    azimuth?: number;
    elevation?: number;
    fov: number;
    padding: number;
    orthographic: boolean;
    fit: "auto" | "sphere" | "box";
  };
  lighting: {
    preset: "studio" | "outdoor" | "flat";
    shadows: boolean;
    ground: "shadow" | "solid" | "none";
    groundColor: string;
  };
  animation: {
    /** Clip name (e.g. animation.walk) or zero-based index. */
    clip?: string;
    /** Clip time in seconds of the frame to render. */
    start: number;
  };
}

/** The resolved settings under the name the rest of the engine uses. */
export type RenderOptions = IRenderSettings;

/** Unvalidated settings from a preset or CLI flags; every field may be missing. */
export type RenderOptionsInput = {
  [K in keyof IRenderSettings]?: IRenderSettings[K] extends object ? Partial<IRenderSettings[K]> : IRenderSettings[K];
};

/** Built-in presets, layered under CLI flags. */
export const PRESETS: Record<string, RenderOptionsInput> = {
  showcase: {
    width: 1920,
    height: 1080,
    supersample: 2,
    toneMapping: "agx",
    background: "#1f2229",
    camera: { view: "three-quarter", fov: 30, padding: 1.08 },
    lighting: { preset: "studio", shadows: true, ground: "shadow" },
  },
  turntable: {
    width: 1920,
    height: 1080,
    supersample: 2,
    toneMapping: "agx",
    background: "#1f2229",
    camera: { view: "three-quarter", fov: 30, padding: 1.08, fit: "sphere" },
    lighting: { preset: "studio", shadows: true, ground: "shadow" },
  },
  icon: {
    width: 512,
    height: 512,
    supersample: 2,
    toneMapping: "neutral",
    background: "transparent",
    camera: { view: "iso", orthographic: true, padding: 1.02 },
    lighting: { preset: "studio", shadows: false, ground: "none" },
  },
  "sprite-sheet-frame": {
    width: 256,
    height: 256,
    supersample: 2,
    toneMapping: "neutral",
    background: "transparent",
    camera: { view: "front", orthographic: true, padding: 1.02 },
    lighting: { preset: "studio", shadows: false, ground: "none" },
  },
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merges plain objects, with `override` winning. Arrays and primitives are replaced, and
 * `undefined` values in `override` are ignored so unset CLI flags never erase preset values.
 */
export function mergeOptions(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(override).reduce<Record<string, unknown>>((merged, [key, value]) => {
    if (value === undefined) return merged;
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) return { ...merged, [key]: mergeOptions(current, value) };
    return { ...merged, [key]: value };
  }, { ...base });
}

const DEFAULTS: Omit<IRenderSettings, "input" | "output"> = {
  width: 1920,
  height: 1080,
  supersample: 2,
  background: "#1f2229",
  toneMapping: "agx",
  exposure: 1,
  textureFilter: "auto",
  camera: { view: "three-quarter", fov: 30, padding: 1.08, orthographic: false, fit: "auto" },
  lighting: { preset: "studio", shadows: true, ground: "shadow", groundColor: "#6b6f78" },
  animation: { start: 0 },
};

/** Collects every problem so one error message lists them all. */
class Problems {
  readonly list: string[] = [];

  /** Picks `value` when it is a finite number within range, else records a problem and returns `fallback`. */
  number(path: string, value: unknown, fallback: number, min: number, max: number, integer = false): number {
    if (value === undefined) return fallback;
    const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
    if (!ok) this.list.push(`  ${path}: expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
    return ok ? (value as number) : fallback;
  }

  /** Picks `value` when it is one of `allowed`, else records a problem and returns `fallback`. */
  choice<T extends string>(path: string, value: unknown, allowed: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    const ok = allowed.includes(value as T);
    if (!ok) this.list.push(`  ${path}: expected one of ${allowed.join(", ")}`);
    return ok ? (value as T) : fallback;
  }
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Validates merged settings and applies defaults.
 *
 * @throws Error listing every invalid field.
 */
export function resolveOptions(raw: RenderOptionsInput & { input?: string; output?: string }): IRenderSettings {
  const problems = new Problems();
  const camera = raw.camera ?? {};
  const lighting = raw.lighting ?? {};
  const animation = raw.animation ?? {};
  const background = raw.background ?? DEFAULTS.background;
  if (background !== "transparent" && !HEX_COLOR.test(background)) problems.list.push('  background: expected a #rgb/#rrggbb hex color or "transparent"');
  if (typeof raw.input !== "string" || raw.input.length === 0) problems.list.push("  input: required");
  if (typeof raw.output !== "string" || raw.output.length === 0) problems.list.push("  output: required");

  const settings: IRenderSettings = {
    input: raw.input ?? "",
    output: raw.output ?? "",
    width: problems.number("width", raw.width, DEFAULTS.width, 16, MAX_DIMENSION, true),
    height: problems.number("height", raw.height, DEFAULTS.height, 16, MAX_DIMENSION, true),
    supersample: problems.number("supersample", raw.supersample, DEFAULTS.supersample, 1, 2, true) as 1 | 2,
    background,
    toneMapping: problems.choice("toneMapping", raw.toneMapping, TONE_MAPPING_NAMES, DEFAULTS.toneMapping),
    exposure: problems.number("exposure", raw.exposure, DEFAULTS.exposure, 0.01, 100),
    textureFilter: problems.choice("textureFilter", raw.textureFilter, ["auto", "nearest", "smooth"], DEFAULTS.textureFilter),
    camera: {
      view: problems.choice("camera.view", camera.view, Object.keys(CAMERA_VIEWS) as CameraView[], DEFAULTS.camera.view),
      ...(camera.azimuth === undefined ? {} : { azimuth: problems.number("camera.azimuth", camera.azimuth, 0, -3600, 3600) }),
      ...(camera.elevation === undefined ? {} : { elevation: problems.number("camera.elevation", camera.elevation, 0, -89.9, 89.9) }),
      fov: problems.number("camera.fov", camera.fov, DEFAULTS.camera.fov, 5, 120),
      padding: problems.number("camera.padding", camera.padding, DEFAULTS.camera.padding, 1, 4),
      orthographic: camera.orthographic ?? DEFAULTS.camera.orthographic,
      fit: problems.choice("camera.fit", camera.fit, ["auto", "sphere", "box"], DEFAULTS.camera.fit),
    },
    lighting: {
      preset: problems.choice("lighting.preset", lighting.preset, ["studio", "outdoor", "flat"], DEFAULTS.lighting.preset),
      shadows: lighting.shadows ?? DEFAULTS.lighting.shadows,
      ground: problems.choice("lighting.ground", lighting.ground, ["shadow", "solid", "none"], DEFAULTS.lighting.ground),
      groundColor: lighting.groundColor ?? DEFAULTS.lighting.groundColor,
    },
    animation: {
      ...(animation.clip === undefined ? {} : { clip: animation.clip }),
      start: problems.number("animation.start", animation.start, DEFAULTS.animation.start, 0, 86_400),
    },
  };
  if (problems.list.length > 0) throw new Error(`Invalid render options:\n${problems.list.join("\n")}`);
  return settings;
}

/**
 * Resolves the camera's azimuth and elevation in degrees, letting explicit angles override the named view.
 * Azimuths are relative to the model's front, which is -Z for Blockbench projects.
 */
export function resolveCameraAngles(camera: RenderOptions["camera"]): { azimuth: number; elevation: number } {
  const view = CAMERA_VIEWS[camera.view];
  return { azimuth: camera.azimuth ?? view.azimuth, elevation: camera.elevation ?? view.elevation };
}
