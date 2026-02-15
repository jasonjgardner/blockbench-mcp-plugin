/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { captureAppScreenshot } from "@/lib/util";
import { STATUS_STABLE } from "@/lib/constants";

export const fromGeoJsonParameters = z.object({
  geojson: z
    .string()
    .describe(
      "Path to the GeoJSON file or data URL, or the GeoJSON string itself."
    ),
});

export const importToolDocs: ToolSpec[] = [
  {
    name: "from_geo_json",
    description: "Imports a model from a GeoJSON file.",
    annotations: {
      title: "Import GeoJSON",
      destructiveHint: true,
    },
    parameters: fromGeoJsonParameters,
    status: STATUS_STABLE,
  },
];

export function registerImportTools() {
  createTool(importToolDocs[0].name, {
    ...importToolDocs[0],
    async execute({ geojson }) {
      // Detect if the input is a URL or a string
      if (!geojson.startsWith("{") && !geojson.startsWith("[")) {
        // Assume it's a URL or file path
        geojson = await fetch(geojson).then((res) => res.text());
      }
      // Parse the GeoJSON string
      if (typeof geojson !== "string") {
        throw new Error("Invalid GeoJSON input. Expected a string.");
      }

      Codecs.bedrock.parse!(JSON.parse(geojson), "");

      return new Promise((resolve) => {
        setTimeout(async () => {
          resolve(await captureAppScreenshot());
        }, 3000);
      });
    },
  }, importToolDocs[0].status);
}
