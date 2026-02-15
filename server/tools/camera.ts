/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { captureScreenshot, captureAppScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { vector3Schema, projectionEnum } from "@/lib/zodObjects";

export const captureScreenshotParameters = z.object({
  project: z.string().optional().describe("Project name or UUID."),
});

export const captureAppScreenshotParameters = z.object({});

export const setCameraAngleParameters = z.object({
  position: vector3Schema.describe("Camera position."),
  target: vector3Schema.optional().describe("Camera target position."),
  rotation: vector3Schema.optional().describe("Camera rotation."),
  projection: projectionEnum.describe("Camera projection type."),
});

export const cameraToolDocs: ToolSpec[] = [
  {
    name: "capture_screenshot",
    description: "Returns the image data of the current view.",
    annotations: {
      title: "Capture Screenshot",
      readOnlyHint: true,
    },
    parameters: captureScreenshotParameters,
    status: STATUS_STABLE,
  },
  {
    name: "capture_app_screenshot",
    description: "Returns the image data of the Blockbench app.",
    annotations: {
      title: "Capture App Screenshot",
      readOnlyHint: true,
    },
    parameters: captureAppScreenshotParameters,
    status: STATUS_STABLE,
  },
  {
    name: "set_camera_angle",
    description: "Sets the camera angle to the specified value.",
    annotations: {
      title: "Set Camera Angle",
      destructiveHint: true,
    },
    parameters: setCameraAngleParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

export function registerCameraTools() {
  createTool(cameraToolDocs[0].name, {
    ...cameraToolDocs[0],
    async execute({ project }) {
      return captureScreenshot(project);
    },
  }, cameraToolDocs[0].status);

  createTool(cameraToolDocs[1].name, {
    ...cameraToolDocs[1],
    async execute() {
      return captureAppScreenshot();
    },
  }, cameraToolDocs[1].status);

  createTool(cameraToolDocs[2].name, {
    ...cameraToolDocs[2],
    async execute(angle: { position: number[]; target?: number[]; rotation?: number[]; projection: string }) {
      const preview = Preview.selected;

      if (!preview) {
        throw new Error("No preview found in the Blockbench editor.");
      }

      // @ts-expect-error Angle CAN be loaded like this
      preview.loadAnglePreset({
        ...angle
      });

      return captureScreenshot();
    },
  }, cameraToolDocs[2].status);
}
