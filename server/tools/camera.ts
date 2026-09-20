/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTool, type IToolSpec } from "@/lib/factories";
import { captureScreenshot, captureAppScreenshot, imageContent } from "@/lib/util";
import {
  ACTIVE_VIEW_ID,
  DEFAULT_OFFSCREEN_VIEW_HEIGHT,
  DEFAULT_OFFSCREEN_VIEW_WIDTH,
  MAX_OFFSCREEN_VIEWS,
  MAX_OFFSCREEN_VIEW_SIZE,
  MIN_OFFSCREEN_VIEW_SIZE,
  NO_COPY_VIEW_ID,
  STATUS_EXPERIMENTAL,
  STATUS_STABLE,
} from "@/lib/constants";
import { lockedAngleEnum, offscreenViewIdSchema, projectionEnum, vec3, viewRefSchema } from "@/lib/zodObjects";
import { createJsonResult } from "@/lib/tool-results";
import {
  createOffscreenView,
  deleteOffscreenView,
  describeView,
  getOffscreenViewCount,
  listViews,
  loadViewAngle,
  renderViewToDataUrl,
  resizeOffscreenView,
  resolveView,
} from "@/lib/views";

const viewDimensionSchema = (label: string) =>
  z.number().int().min(MIN_OFFSCREEN_VIEW_SIZE).max(MAX_OFFSCREEN_VIEW_SIZE)
    .describe(`${label} in pixels (${MIN_OFFSCREEN_VIEW_SIZE}–${MAX_OFFSCREEN_VIEW_SIZE}).`);

/** `view` field shared by tools that can address any render target; defaults to the user's viewport. */
const targetViewSchema = viewRefSchema.optional().default(ACTIVE_VIEW_ID);

export const captureScreenshotParameters = z.object({
  project: z.string().optional().describe("Project name or UUID."),
  view: targetViewSchema,
});

export const captureAppScreenshotParameters = z.object({});

export const setCameraAngleParameters = z.object({
  view: targetViewSchema,
  position: vec3("Camera position."),
  target: vec3("Camera target position.").optional(),
  rotation: vec3("Camera rotation.").optional(),
  projection: projectionEnum.describe("Camera projection type."),
  zoom: z.number().positive().optional()
    .describe("Orthographic zoom factor (Blockbench default 0.5). Ignored for perspective views and while a side view is locked."),
  fov: z.number().min(1).max(179).optional()
    .describe("Perspective field of view in degrees. Uses the Blockbench setting when omitted."),
  locked_angle: lockedAngleEnum.optional()
    .describe("Lock an orthographic side view (top, bottom, north, south, east, west). Omit to leave the view free."),
}).refine(angle => !(angle.locked_angle && angle.projection === "perspective"), {
  message: 'locked_angle requires projection "orthographic", or "unset" on a view that is already orthographic.',
  path: ["locked_angle"],
});

export const createOffscreenViewParameters = z.object({
  id: offscreenViewIdSchema.optional().describe("ID for the new view. Generated as view_N when omitted."),
  width: viewDimensionSchema("Width").optional().default(DEFAULT_OFFSCREEN_VIEW_WIDTH),
  height: viewDimensionSchema("Height").optional().default(DEFAULT_OFFSCREEN_VIEW_HEIGHT),
  antialias: z.boolean().optional().default(true)
    .describe("Multisample antialiasing. Disable for crisp pixel-art inspection."),
  copy_view: z.union([viewRefSchema, z.literal(NO_COPY_VIEW_ID)]).optional().default(ACTIVE_VIEW_ID)
    .describe(`View whose camera seeds the new one. Defaults to "${ACTIVE_VIEW_ID}" (the user's viewport); pass "${NO_COPY_VIEW_ID}" for Blockbench's default angle.`),
});

export const listViewsParameters = z.object({});

export const resizeOffscreenViewParameters = z.object({
  view: offscreenViewIdSchema.describe("ID of the offscreen view to resize."),
  width: viewDimensionSchema("Width"),
  height: viewDimensionSchema("Height"),
});

export const deleteOffscreenViewParameters = z.object({
  view: offscreenViewIdSchema.describe("ID of the offscreen view to dispose."),
});

type CaptureScreenshotArgs = z.infer<typeof captureScreenshotParameters>;
type SetCameraAngleArgs = z.infer<typeof setCameraAngleParameters>;
type CreateOffscreenViewArgs = z.infer<typeof createOffscreenViewParameters>;
type ResizeOffscreenViewArgs = z.infer<typeof resizeOffscreenViewParameters>;
type DeleteOffscreenViewArgs = z.infer<typeof deleteOffscreenViewParameters>;

const captureScreenshotSpec: IToolSpec = {
  name: "capture_screenshot",
  condition: () => ModelProject.all.length > 0,
  description:
    `Returns the rendered image of a view. Defaults to the user's active viewport ("${ACTIVE_VIEW_ID}"); pass the ID of an offscreen view from create_offscreen_view to render without disturbing the user, or a viewport ID from list_views.`,
  annotations: {
    title: "Capture Screenshot",
    readOnlyHint: true,
  },
  parameters: captureScreenshotParameters,
  status: STATUS_STABLE,
};

const captureAppScreenshotSpec: IToolSpec = {
  name: "capture_app_screenshot",
  condition: () => !Blockbench.isWeb,
  description: "Returns the image data of the Blockbench app.",
  annotations: {
    title: "Capture App Screenshot",
    readOnlyHint: true,
  },
  parameters: captureAppScreenshotParameters,
  status: STATUS_STABLE,
};

const setCameraAngleSpec: IToolSpec = {
  name: "set_camera_angle",
  condition: { project: true, method: () => Boolean(Preview.selected) || getOffscreenViewCount() > 0 },
  description:
    "Moves a view's camera and returns the resulting frame plus the applied camera state. Defaults to the user's active viewport, which changes what they see and clears any side-view lock they had; target an offscreen view from create_offscreen_view to inspect the model from any angle without moving their camera.",
  annotations: {
    title: "Set Camera Angle",
    destructiveHint: true,
  },
  parameters: setCameraAngleParameters,
  status: STATUS_EXPERIMENTAL,
};

const createOffscreenViewSpec: IToolSpec = {
  name: "create_offscreen_view",
  description:
    `Creates a private offscreen viewport that renders the current project without moving the user's camera. Use it with set_camera_angle and capture_screenshot (view: <id>) for multi-angle inspection. The camera starts where the user's is unless copy_view is "${NO_COPY_VIEW_ID}". Up to ${MAX_OFFSCREEN_VIEWS} views may exist at once; delete them with delete_offscreen_view when done.`,
  annotations: {
    title: "Create Offscreen View",
    idempotentHint: false,
  },
  parameters: createOffscreenViewParameters,
  status: STATUS_EXPERIMENTAL,
};

const listViewsSpec: IToolSpec = {
  name: "list_views",
  description:
    "Lists render targets: the user's connected viewports (the active one flagged) and the plugin's offscreen views, each with size and camera position, target, projection, FOV, zoom, and side-view lock.",
  annotations: {
    title: "List Views",
    readOnlyHint: true,
  },
  parameters: listViewsParameters,
  status: STATUS_EXPERIMENTAL,
};

const resizeOffscreenViewSpec: IToolSpec = {
  name: "resize_offscreen_view",
  description: "Changes the pixel size of an offscreen view. The user's viewports follow their layout and cannot be resized here.",
  annotations: {
    title: "Resize Offscreen View",
    idempotentHint: true,
  },
  parameters: resizeOffscreenViewParameters,
  status: STATUS_EXPERIMENTAL,
};

const deleteOffscreenViewSpec: IToolSpec = {
  name: "delete_offscreen_view",
  description: "Disposes an offscreen view and releases its WebGL context. The user's viewports are not affected.",
  annotations: {
    title: "Delete Offscreen View",
    destructiveHint: true,
  },
  parameters: deleteOffscreenViewParameters,
  status: STATUS_EXPERIMENTAL,
};

export const cameraToolDocs: IToolSpec[] = [
  captureScreenshotSpec,
  captureAppScreenshotSpec,
  setCameraAngleSpec,
  createOffscreenViewSpec,
  listViewsSpec,
  resizeOffscreenViewSpec,
  deleteOffscreenViewSpec,
];

export function registerCameraTools() {
  createTool(captureScreenshotSpec.name, {
    ...captureScreenshotSpec,
    async execute({ project, view }: CaptureScreenshotArgs) {
      return captureScreenshot(project, view);
    },
  }, captureScreenshotSpec.status);

  createTool(captureAppScreenshotSpec.name, {
    ...captureAppScreenshotSpec,
    async execute() {
      return captureAppScreenshot();
    },
  }, captureAppScreenshotSpec.status);

  createTool(setCameraAngleSpec.name, {
    ...setCameraAngleSpec,
    async execute({ view, ...angle }: SetCameraAngleArgs): Promise<CallToolResult> {
      const preview = resolveView(view);
      loadViewAngle(preview, angle);
      const image = imageContent(renderViewToDataUrl(preview), "image/png");
      // Describe after rendering: orbit controls clamp the distance during render.
      const result = { view: describeView(preview) };
      return {
        content: [...image.content, { type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  }, setCameraAngleSpec.status);

  createTool(createOffscreenViewSpec.name, {
    ...createOffscreenViewSpec,
    async execute({ id, width, height, antialias, copy_view }: CreateOffscreenViewArgs) {
      return createJsonResult({ view: createOffscreenView({ id, width, height, antialias, copyFrom: copy_view }) });
    },
  }, createOffscreenViewSpec.status);

  createTool(listViewsSpec.name, {
    ...listViewsSpec,
    async execute() {
      return createJsonResult({ views: listViews() });
    },
  }, listViewsSpec.status);

  createTool(resizeOffscreenViewSpec.name, {
    ...resizeOffscreenViewSpec,
    async execute({ view, width, height }: ResizeOffscreenViewArgs) {
      return createJsonResult({ view: resizeOffscreenView(view, width, height) });
    },
  }, resizeOffscreenViewSpec.status);

  createTool(deleteOffscreenViewSpec.name, {
    ...deleteOffscreenViewSpec,
    async execute({ view }: DeleteOffscreenViewArgs) {
      deleteOffscreenView(view);
      return createJsonResult({ deleted: view, offscreen_views: getOffscreenViewCount() });
    },
  }, deleteOffscreenViewSpec.status);
}
