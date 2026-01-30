/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { captureScreenshot, captureAppScreenshot } from "@/lib/util";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { vector3Schema, projectionEnum } from "@/lib/zodObjects";

export function registerCameraTools() {
  createTool(
    "capture_screenshot",
    {
      description: "Returns the image data of the current view.",
      annotations: {
        title: "Capture Screenshot",
        readOnlyHint: true,
      },
      parameters: z.object({
        project: z.string().optional().describe("Project name or UUID."),
      }),
      async execute({ project }) {
        return captureScreenshot(project);
      },
    },
    STATUS_STABLE
  );

  createTool(
    "capture_app_screenshot",
    {
      description: "Returns the image data of the Blockbench app.",
      annotations: {
        title: "Capture App Screenshot",
        readOnlyHint: true,
      },
      parameters: z.object({}),
      async execute() {
        return captureAppScreenshot();
      },
    },
    STATUS_STABLE
  );

  createTool(
    "set_camera_angle",
    {
      description: "Sets the camera angle to the specified value.",
      annotations: {
        title: "Set Camera Angle",
        destructiveHint: true,
      },
      parameters: z.object({
          position: vector3Schema.describe("Camera position."),
          target: vector3Schema.optional().describe("Camera target position."),
          rotation: vector3Schema.optional().describe("Camera rotation."),
          projection: projectionEnum.describe("Camera projection type."),
      }),
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
    },
    STATUS_EXPERIMENTAL
  );
}
