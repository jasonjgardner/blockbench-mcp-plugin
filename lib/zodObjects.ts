import { z } from "zod";

export const cubeSchema = z.object({
  name: z.string(),
  origin: z
    .array(z.number()).length(3)
    .describe("Pivot point of the cube."),
  from: z
    .array(z.number()).length(3)
    .describe("Starting point of the cube."),
  to: z
    .array(z.number()).length(3)
    .describe("Ending point of the cube."),
  rotation: z
    .array(z.number()).length(3)
    .describe("Rotation of the cube."),
});

export const meshSchema = z.object({
  name: z.string(),
  position: z
    .array(z.number()).length(3)
    .describe("Position of the mesh."),
  rotation: z
    .array(z.number()).length(3)
    .describe("Rotation of the mesh."),
  scale: z
    .array(z.number()).length(3)
    .describe("Scale of the mesh."),
  vertices: z
    .array(
      z
        .array(z.number())
        .length(3)
        .describe("Vertex coordinates in the mesh.")
    )
    .describe("Vertices of the mesh."),
});