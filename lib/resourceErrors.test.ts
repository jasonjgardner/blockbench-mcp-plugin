import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { resourceNotFound, withResourceErrors } from "./resourceErrors";

describe("resource protocol errors", () => {
  test("missing resources carry Invalid Params and the requested URI", () => {
    expect(resourceNotFound(new URL("projects://missing"))).toMatchObject({ code: -32602, data: { uri: "projects://missing" } });
  });

  test("preserves explicit MCP errors including their data", async () => {
    const failure = new McpError(ErrorCode.InvalidParams, "Missing", { uri: "projects://missing" });
    await expect(withResourceErrors(() => { throw failure; })).rejects.toBe(failure);
  });

  test("maps asynchronous and synchronous failures to Internal Error", async () => {
    await expect(withResourceErrors(() => { throw new Error("Cannot serialize"); }, "nodes://head"))
      .rejects.toMatchObject({ code: -32603, data: { uri: "nodes://head" } });
    await expect(withResourceErrors(() => Promise.reject("Unknown failure")))
      .rejects.toMatchObject({ code: -32603 });
  });

  test("preserves valid empty lists and resource contents", async () => {
    const listed = { resources: [] };
    const read = { contents: [{ uri: "projects://", text: "[]" }] };
    expect(await withResourceErrors(() => listed)).toBe(listed);
    expect(await withResourceErrors(() => read)).toBe(read);
  });
});
