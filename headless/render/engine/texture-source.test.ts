import { describe, expect, test } from "bun:test";

import { embeddedImageBytes } from "./texture-source";

describe("embeddedImageBytes", () => {
  test("decodes embedded images and refuses file paths and other URLs", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(embeddedImageBytes(`data:image/png;base64,${bytes.toString("base64")}`)).toEqual(bytes);
    for (const url of ["file:///C:/Users/me/secret.png", "/home/me/secret.png", "C:\\Users\\me\\secret.png", "../secret.png", "https://example.com/texture.png"]) {
      expect(() => embeddedImageBytes(url)).toThrow("only images embedded in the model");
    }
  });
});
