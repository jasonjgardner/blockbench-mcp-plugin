import { describe, expect, test } from "bun:test";
import { applyImageOutput, encodeImage, fitWithin } from "@/lib/image-output";
import { useGlobals } from "@/tests/helpers/globals";

/** One `drawImage` onto a canvas the encoder created. */
interface IDraw {
  width: number;
  height: number;
  /** Canvas fill in effect when the image was drawn: the JPEG background. */
  fill: string;
}

let draws: IDraw[] = [];

/** `Image` double: every data URL decodes to a 1000×500 picture. */
class TestImage {
  src = "";
  readonly naturalWidth = 1000;
  readonly naturalHeight = 500;
  async decode(): Promise<void> {}
}

/** Canvas double whose data URL records the requested type and the canvas size. */
function createCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => {
      const context = {
        fillStyle: "",
        filled: "",
        imageSmoothingQuality: "low",
        fillRect: () => { context.filled = context.fillStyle; },
        drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => {
          draws.push({ width, height, fill: context.filled });
        },
      };
      return context;
    },
    toDataURL: (type: string) => `data:${type};base64,${btoa(`${canvas.width}x${canvas.height}`)}`,
  };
  return canvas;
}

useGlobals(() => {
  draws = [];
  return { Image: TestImage, document: { createElement: () => createCanvas() } };
});

const png = `data:image/png;base64,${btoa("frame")}`;

test("fitWithin scales the longest side down and never up", () => {
  expect(fitWithin(1000, 500, 200)).toEqual({ width: 200, height: 100 });
  expect(fitWithin(500, 1000, 200)).toEqual({ width: 100, height: 200 });
  expect(fitWithin(1000, 500, 4000)).toEqual({ width: 1000, height: 500 });
  expect(fitWithin(1000, 500)).toEqual({ width: 1000, height: 500 });
  expect(fitWithin(4000, 1, 16)).toEqual({ width: 16, height: 1 });
});

describe("encodeImage", () => {
  test("returns a PNG unchanged when no smaller size is asked for", async () => {
    expect(await encodeImage(png, {})).toBe(png);
    expect(await encodeImage(png, { format: "png", max_size: 4000 })).toBe(png);
    expect(draws).toEqual([]);
  });

  test("scales to max_size and encodes the requested format", async () => {
    expect(await encodeImage(png, { max_size: 200, format: "webp" })).toBe(`data:image/webp;base64,${btoa("200x100")}`);
    expect(draws).toEqual([{ width: 200, height: 100, fill: "" }]);
  });

  test("puts JPEG on a white background, since it has no transparency", async () => {
    expect(await encodeImage(png, { format: "jpeg" })).toBe(`data:image/jpeg;base64,${btoa("1000x500")}`);
    expect(draws).toEqual([{ width: 1000, height: 500, fill: "#ffffff" }]);
  });
});

describe("applyImageOutput", () => {
  const result = {
    content: [
      { type: "text" as const, text: "warning" },
      { type: "image" as const, data: btoa("frame"), mimeType: "image/png" },
    ],
  };

  test("leaves results alone without options", async () => {
    expect(await applyImageOutput(result, {})).toBe(result);
  });

  test("re-encodes image items and keeps the others", async () => {
    expect(await applyImageOutput(result, { max_size: 100, format: "jpeg" })).toEqual({
      content: [
        { type: "text", text: "warning" },
        { type: "image", data: btoa("100x50"), mimeType: "image/jpeg" },
      ],
    });
  });
});
