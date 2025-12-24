import html2canvas from "html2canvas";

/**
 * Helper function to create properly formatted image content for MCP responses.
 * Handles data URLs, base64 strings, and objects with url property.
 *
 * @param dataOrOptions - Image data as base64/data URL string, or object with { url: string }
 * @param mimeType - MIME type of the image (e.g., 'image/png', 'image/jpeg')
 * @returns Formatted MCP tool result with image content
 */
export function imageContent(
  dataOrOptions: string | { url: string },
  mimeType: string = "image/png"
): { content: Array<{ type: "image"; data: string; mimeType: string }> } {
  // Handle object with url property
  const data = typeof dataOrOptions === "string" ? dataOrOptions : dataOrOptions.url;
  let base64Data = data;

  // If it's a data URL, extract the base64 part
  if (data.startsWith("data:")) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1] || mimeType;
      base64Data = matches[2];
    }
  }

  return {
    content: [
      {
        type: "image" as const,
        data: base64Data,
        mimeType,
      },
    ],
  };
}

export function fixCircularReferences<
  T extends Record<string, any>,
  K extends keyof T,
  V extends T[K]
>(o: T): (k: K, v: V) => V | string {
  const weirdTypes = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    BigInt64Array,
    BigUint64Array,
    //Float16Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    // SharedArrayBuffer,
    DataView,
  ];

  const defs = new Map();

  return function (k: K, v: V): V | string {
    if (k && (v as unknown) === o)
      return "[" + (k as string) + " is the same as original object]";
    if (v === undefined) return undefined as V;
    if (v === null) return null as V;
    const weirdType = weirdTypes.find((t) => (v as unknown) instanceof t);
    if (weirdType) return weirdType.toString();
    if (typeof v == "function") {
      return v.toString();
    }
    if (v && typeof v == "object") {
      const def = defs.get(v);
      if (def)
        return "[" + (k as string) + " is the same as " + (def as string) + "]";
      defs.set(v, k);
    }
    return v;
  };
}

export function getProjectTexture(id: string): Texture | null {
  const texture = (Project?.textures ?? Texture.all).find(
    ({ id: textureId, name, uuid }) =>
      textureId === id || name === id || uuid === id
  );

  return texture || null;
}

export function captureScreenshot(project?: string) {
  let selectedProject = Project;

  if (!selectedProject || project !== undefined) {
    selectedProject = ModelProject.all.find(
      (p) => p.name === project || p.uuid === project || p.selected
    );
  }

  if (!selectedProject) {
    throw new Error("No project found in the Blockbench editor.");
  }

  if (selectedProject.select()) {
    selectedProject.updateThumbnail();
  }

  return imageContent(selectedProject.thumbnail, "image/png");
}

/**
 * Captures a screenshot of the Blockbench application window.
 * Tries Electron's native capture first (better quality, no CSS issues),
 * falls back to html2canvas if Electron capture is not available.
 */
export async function captureAppScreenshot() {
  // Try Electron's native capture first (available in desktop app)
  // This avoids html2canvas CSS parsing issues with modern color functions
  if (typeof Blockbench !== 'undefined' && Blockbench.isApp) {
    try {
      // Access Electron's remote module or webContents
      const electronModule = typeof require !== 'undefined' ? require('electron') : null;
      if (electronModule?.remote?.getCurrentWindow) {
        const win = electronModule.remote.getCurrentWindow();
        const image = await win.webContents.capturePage();
        const dataUrl = image.toDataURL();
        return imageContent(dataUrl, "image/png");
      }
    } catch (electronError) {
      console.warn("Electron capture not available, trying html2canvas:", electronError);
    }
  }

  // Fallback to html2canvas with error handling for unsupported CSS
  try {
    const canvas = await html2canvas(document.documentElement, {
      // Ignore CSS parsing errors for unsupported color functions
      logging: false,
      useCORS: true,
      allowTaint: true,
      // Use a custom onclone to strip problematic styles
      onclone: (clonedDoc) => {
        // Remove or replace problematic CSS that html2canvas can't handle
        const styles = clonedDoc.querySelectorAll('style');
        styles.forEach((style) => {
          if (style.textContent) {
            // Replace color() function with fallback colors
            style.textContent = style.textContent.replace(
              /color\([^)]+\)/g,
              'currentColor'
            );
          }
        });
      },
    });
    const dataUrl = canvas.toDataURL();
    return imageContent(dataUrl, "image/png");
  } catch (html2canvasError) {
    // If html2canvas still fails, try a more aggressive approach
    console.warn("html2canvas failed, trying simplified capture:", html2canvasError);

    try {
      // Try capturing just the main preview canvas if available
      const previewCanvas = document.querySelector('#preview canvas') as HTMLCanvasElement;
      if (previewCanvas) {
        const dataUrl = previewCanvas.toDataURL('image/png');
        const imgResult = imageContent(dataUrl, "image/png");
        return {
          content: [
            { type: "text" as const, text: "Note: Full app screenshot failed due to CSS compatibility. Returning preview canvas only." },
            ...imgResult.content,
          ],
        };
      }
    } catch (canvasError) {
      console.error("Canvas capture also failed:", canvasError);
    }

    // Return error with helpful message
    throw new Error(
      `Failed to capture app screenshot: ${html2canvasError}. ` +
      "This may be due to modern CSS features not supported by html2canvas. " +
      "Try using capture_screenshot instead for the 3D preview."
    );
  }
}