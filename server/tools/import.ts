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
      // If input looks like JSON, use it directly
      if (!geojson.startsWith("{") && !geojson.startsWith("[")) {
        let parsed: URL;
        try {
          parsed = new URL(geojson);
        } catch {
          throw new Error(
            `Invalid URL or file path: "${geojson}". Expected a URL (http/https) or inline GeoJSON.`
          );
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(
            `Unsupported protocol "${parsed.protocol}". Only http: and https: URLs are allowed.`
          );
        }

        const hostname = parsed.hostname.toLowerCase();
        const blockedPatterns: Array<RegExp> = []; // TODO: Add patterns for private IPs, localhost, etc. if needed

        if (blockedPatterns.some((p) => p.test(hostname))) {
          throw new Error(
            `Blocked request to address "${hostname}".`
          );
        }

        const res = await fetch(parsed.href);
        if (!res.ok) {
          throw new Error(
            `Failed to fetch GeoJSON from "${parsed.href}": ${res.status} ${res.statusText}`
          );
        }
        geojson = await res.text();
      }
      // Parse the GeoJSON string
      if (typeof geojson !== "string") {
        throw new Error("Invalid GeoJSON input. Expected a string.");
      }

      Codecs.bedrock.parse!(JSON.parse(geojson), "");

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          captureAppScreenshot().then(resolve).catch(reject);
        }, 3000);
      });
    },
  }, importToolDocs[0].status);
}
