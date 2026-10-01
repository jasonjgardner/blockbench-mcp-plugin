/**
 * Texture images the renderer may read. The headless server inlines every texture a model can use
 * as a data URL before rendering (`../input.ts`), so any other URL, such as a file path saved in the
 * model, is refused instead of read: whatever three-blockbench builds from a model's paths, the
 * render cannot open files outside the workspace.
 */

/**
 * The bytes of a base64 `data:` URL.
 *
 * @throws Error for any other URL.
 */
export function embeddedImageBytes(url: string): Buffer {
  if (!url.startsWith("data:")) throw new Error(`Refusing to read texture ${url}: only images embedded in the model are rendered.`);
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}
