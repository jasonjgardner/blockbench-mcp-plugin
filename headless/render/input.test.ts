import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelStore } from "../document/store";
import { creatureModel } from "../test-fixtures";
import { writeRenderInput } from "./input";

const ONE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_2X4 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAFklEQVR4nGP838Dwn4GBgYEJRGBnAABUcQKGuqbVnwAAAABJRU5ErkJggg==";

describe("render input", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-headless-render-"));
    outside = await mkdtemp(join(tmpdir(), "bb-headless-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("textures keep embedded images and inline PNGs linked inside the workspace; files outside are never read", async () => {
    const secret = join(outside, "secret.png");
    await Bun.write(secret, Buffer.from(PNG_2X4, "base64"));
    await Bun.write(join(root, "art", "skin.png"), Buffer.from(ONE_PIXEL, "base64"));
    const embedded = `data:image/png;base64,${ONE_PIXEL}`;
    const texture = (name: string, fields: Record<string, unknown>) => ({ uuid: crypto.randomUUID(), name, ...fields });
    const doc = {
      ...creatureModel(),
      textures: [
        texture("embedded", { source: embedded, path: secret, relative_path: "../../secret.png" }),
        texture("linked", { path: "", relative_path: "../art/skin.png" }),
        texture("absolute", { path: join(root, "art", "skin.png") }),
        texture("outside", { path: secret }),
        texture("planted", { source: secret }),
        texture("missing", { relative_path: "gone.png" }),
        texture("blank", {}),
      ],
    };
    const modelPath = join(root, "models", "m.bbmodel");
    await Bun.write(modelPath, JSON.stringify(doc));

    const input = await writeRenderInput(new ModelStore({ roots: [root] }), modelPath, join(root, "scratch"));
    const text = await Bun.file(input.path).text();
    const copy = JSON.parse(text) as { textures: Record<string, unknown>[]; elements: unknown[] };
    expect(text).not.toContain(PNG_2X4);
    expect(copy.elements).toEqual(doc.elements);
    expect(copy.textures.map((entry) => [entry.name, entry.source ?? null])).toEqual([
      ["embedded", embedded],
      ["linked", embedded],
      ["absolute", embedded],
      ["outside", null],
      ["planted", null],
      ["missing", null],
      ["blank", null],
    ]);
    expect(copy.textures.every((entry) => entry.path === undefined && entry.relative_path === undefined)).toBe(true);
    expect(input.warnings).toHaveLength(3);
    expect(input.warnings[0]).toStartWith('Texture "outside" renders without its image:');
    expect(input.warnings[0]).toContain("outside the workspace");
    expect(input.warnings[1]).toContain("source is not an embedded image");
    expect(input.warnings[2]).toContain("does not exist");

    await input.dispose();
    expect(await readdir(join(root, "scratch"))).toEqual([]);
  });
});
