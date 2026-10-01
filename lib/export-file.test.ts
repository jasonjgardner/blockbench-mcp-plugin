import { expect, test } from "bun:test";
import { isAbsoluteExportPath, writeExportFile } from "./export-file";
import { useGlobals } from "@/tests/helpers/globals";

const writes: string[] = [];

useGlobals(() => ({
  requireNativeModule: () => ({
    writeFileSync(path: string) {
      writes.push(path);
    },
  }),
}));

test("local absolute paths are accepted", () => {
  for (const path of ["C:\\exports\\model.json", "C:/exports/model.json", "/home/user/model.json"]) {
    expect(isAbsoluteExportPath(path)).toBe(true);
  }
});

test("relative, network and device paths are refused", () => {
  for (const path of [
    "model.json",
    "exports/model.json",
    "\\\\server\\share\\model.json",
    "//server/share/model.json",
    "\\/server/share/model.json",
    "/\\server\\share\\model.json",
    "\\\\?\\C:\\model.json",
    "\\\\.\\pipe\\model",
    "C:\\exports\\COM1.json",
    "C:\\exports\\nul.json",
    "/home/user/con",
  ]) {
    expect(isAbsoluteExportPath(path)).toBe(false);
  }
});

test("a network path never reaches the file system", () => {
  writes.length = 0;
  expect(() => writeExportFile("\\\\server\\share\\model.json", "{}", false, "export_model")).toThrow("network (UNC)");
  expect(writes).toEqual([]);
  expect(writeExportFile("C:\\exports\\model.json", "{}", false, "export_model")).toBe("C:\\exports\\model.json");
  expect(writes).toEqual(["C:\\exports\\model.json"]);
});
