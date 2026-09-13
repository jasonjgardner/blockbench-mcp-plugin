import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { getAllToolDefinitions } from "@/lib/factories";
import { isRecord } from "./assertions";
import { executeStructured, executeText, executeTool, type IRegisteredTool, type ToolRegistry } from "./tool-execution";

interface IPayload {
  readonly count: number;
  readonly items: readonly string[];
}

const payload: IPayload = { count: 2, items: ["a", "b"] };
const isPayload = (value: unknown): value is IPayload => isRecord(value) && typeof value.count === "number" && Array.isArray(value.items);
const noParameters = z.object({});

function returning(result: unknown): IRegisteredTool {
  return { execute: async () => result, parameterSchema: noParameters };
}

const echo = mock(async (args: Record<string, unknown>) => `echo:${String(args.text)}`);
const registry: ToolRegistry = {
  echo: { execute: echo, parameterSchema: z.object({ text: z.string().min(1).default("hello") }) },
  mismatched: returning({ content: [{ text: JSON.stringify({ ...payload, count: 3 }), type: "text" }], structuredContent: payload }),
  noText: returning({ content: [{ data: "AA==", mimeType: "image/png", type: "image" }], structuredContent: payload }),
  notJson: returning({ content: [{ text: "{invalid", type: "text" }], structuredContent: payload }),
  scalar: { execute: async () => "unreachable", parameterSchema: z.string() },
  structured: returning({ content: [{ data: "AA==", mimeType: "image/png", type: "image" }, { text: JSON.stringify(payload), type: "text" }], structuredContent: payload }),
  textOnly: returning("plain text"),
  unstructured: returning({ content: [{ text: "{}", type: "text" }] }),
};

describe("executeTool", () => {
  test("parses raw input once, applying defaults before execute", async () => {
    echo.mockClear();
    expect(await executeTool("echo", {}, registry)).toBe("echo:hello");
    expect(echo).toHaveBeenCalledWith({ text: "hello" });
  });

  test("rejects invalid input before execute runs", async () => {
    echo.mockClear();
    await expect(executeTool("echo", { text: "" }, registry)).rejects.toBeInstanceOf(z.ZodError);
    expect(echo).not.toHaveBeenCalled();
  });

  test("rejects unregistered names, including inherited object keys", async () => {
    await expect(executeTool("missing", {}, registry)).rejects.toThrow('Tool "missing" is not registered');
    await expect(executeTool("toString", {}, registry)).rejects.toThrow('Tool "toString" is not registered');
  });

  test("rejects schemas that do not produce an argument object", async () => {
    await expect(executeTool("scalar", "text", registry)).rejects.toThrow('parameters parsed to a value of type string');
  });

  test("defaults to the live factories registry", async () => {
    const name = "__helpers_execution_probe";
    const definitions = getAllToolDefinitions();
    definitions[name] = {
      configuredEnabled: true,
      description: "Probe", execute: async (args) => `probe:${String(args.value)}`, inputSchema: {},
      parameterSchema: z.object({ value: z.number().default(7) }), title: "Probe",
    };
    try {
      expect(await executeText(name)).toBe("probe:7");
    } finally {
      Reflect.deleteProperty(definitions, name);
    }
    await expect(executeTool(name)).rejects.toThrow("is not registered");
  });
});

describe("executeText", () => {
  test("returns text and rejects structured results", async () => {
    expect(await executeText("textOnly", {}, registry)).toBe("plain text");
    await expect(executeText("structured", {}, registry)).rejects.toThrow('Expected tool "structured" to return text, but it returned a value of type object.');
  });
});

describe("executeStructured", () => {
  test("narrows structuredContent after verifying its JSON text mirror", async () => {
    const result = await executeStructured("structured", {}, isPayload, registry);
    expect(result.items).toEqual(["a", "b"]);
    expect(result).toBe(payload);
  });

  test.each([
    ["textOnly", 'Expected tool "textOnly" to return structured content, but it returned a value of type string.'],
    ["unstructured", 'Tool "unstructured" returned content without structuredContent.'],
    ["noText", 'Tool "noText" returned structuredContent without a JSON text item.'],
    ["mismatched", 'Tool "mismatched" JSON text does not match its structuredContent.'],
  ])("rejects %s results", async (name, message) => {
    await expect(executeStructured(name, {}, isPayload, registry)).rejects.toThrow(message);
  });

  test("keeps the JSON syntax error as the cause", async () => {
    const error = await executeStructured("notJson", {}, isPayload, registry).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.cause).toBeInstanceOf(SyntaxError);
  });

  test("rejects content that fails the shape guard", async () => {
    const isString = (value: unknown): value is string => typeof value === "string";
    await expect(executeStructured("structured", {}, isString, registry)).rejects.toThrow("does not have the expected shape");
  });
});
