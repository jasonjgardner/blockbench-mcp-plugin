import { z } from "zod";

export const cubeSchema = z.object({
  name: z.string(),
  origin: z
    .array(z.number()).length(3)
    .describe("Pivot point of the cube.")
    .optional()
    .default([0, 0, 0]),
  from: z
    .array(z.number()).length(3)
    .describe("Starting point of the cube.")
    .optional()
    .default([0, 0, 0]),
  to: z
    .array(z.number()).length(3)
    .describe("Ending point of the cube.")
    .optional()
    .default([1, 1, 1]),
  rotation: z
    .array(z.number()).length(3)
    .describe("Rotation of the cube.")
    .optional()
    .default([0, 0, 0]),
});

export const meshSchema = z.object({
  name: z.string(),
  position: z
    .array(z.number()).length(3)
    .describe("Position of the mesh.")
    .optional()
    .default([0, 0, 0]),
  rotation: z
    .array(z.number()).length(3)
    .describe("Rotation of the mesh.")
    .optional()
    .default([0, 0, 0]),
  scale: z
    .array(z.number()).length(3)
    .describe("Scale of the mesh.")
    .optional()
    .default([1, 1, 1]),
  vertices: z
    .array(
      z
        .array(z.number())
        .length(3)
        .describe("Vertex coordinates in the mesh.")
    )
    .describe("Vertices of the mesh.")
    .optional()
    .default([]),
});