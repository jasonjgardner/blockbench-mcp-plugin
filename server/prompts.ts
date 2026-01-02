import { z } from "zod";
import { createPrompt, prompts } from "@/lib/factories";
import { readPrompt } from "@/macros/readPrompt" with { type: "macro" };

createPrompt("blockbench_native_apis", {
  description:
    "Essential information about Blockbench v5.0 native API security model and requireNativeModule() usage. Use this when working with Node.js modules, file system access, or native APIs in Blockbench plugins.",
  argsSchema: z.object({}),
  async generate() {
    const text = await readPrompt("blockbench_native_apis");
    return {
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
});

createPrompt("blockbench_code_eval_safety", {
  description:
    "Critical safety guide for agents using code evaluation/execution tools with Blockbench v5.0+. Contains breaking changes, quick reference, common mistakes, and safe code patterns for native module usage. MUST READ before generating or executing Blockbench plugin code.",
  argsSchema: z.object({}),
  async generate() {
    const text = await readPrompt("blockbench_code_eval_safety");
    return {
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
});

createPrompt("model_creation_strategy", {
  description: "A strategy for creating a new 3D model in Blockbench.",
  argsSchema: z.object({
    format: z.enum(["java_block", "bedrock"]).optional(),
    approach: z.enum(["ui", "programmatic", "import"]).optional(),
  }),
  async generate({ format, approach }) {
    const result: string[] = [];

    if (format === "java_block") {
      result.push(await readPrompt("java_block"));
    }

    if (format === "bedrock") {
      result.push(await readPrompt("bedrock_block"));
    }

    if (approach === "ui") {
      result.push(await readPrompt("model_creation_ui"));
    }

    if (approach === "programmatic") {
      result.push(await readPrompt("model_creation_programmatic"));
    }

    if (approach === "import") {
      result.push(await readPrompt("model_creation_import"));
    }

    return {
      messages: [{ role: "user", content: { type: "text", text: result.join("\n") } }],
    };
  },
});

export default prompts;