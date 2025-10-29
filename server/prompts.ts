import { createPrompt, prompts } from "@/lib/factories";
import { readPrompt } from "@/macros/readPrompt" with { type: 'macro' };
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";

createPrompt("model_creation_strategy", {
    description: "A strategy for creating a new 3D model in Blockbench.",
    argsSchema: z.object({
        format: completable(
            z.enum(["java_block", "bedrock"]).optional(),
            (value) => {
                if (value.startsWith("java")) {
                    return ["java_block"];
                }
                if (value.startsWith("b")) {
                    return ["bedrock"];
                }
                return ["java_block", "bedrock"];
            }
        ),
        approach: completable(
            z.enum(["ui", "programmatic", "import"]).optional(),
            (value) => {
                if (value.startsWith("u")) {
                    return ["ui"];
                }
                if (value.startsWith("p")) {
                    return ["programmatic"];
                }
                if (value.startsWith("i")) {
                    return ["import"];
                }
                return ["ui", "programmatic", "import"];
            }
        )
    }),
    callback: async (args) => {
        const { format, approach } = args;
        const result: string[] = [];

        if (format === "java_block") {
            result.push(await readPrompt("java_block"));
        }
        
        if (format === "bedrock") {
            result.push(await readPrompt("bedrock_block"));
        }

        if (approach === "ui") {
            result.push(await readPrompt("model_creation_ui"));
        } else if (approach === "programmatic") {
            result.push(await readPrompt("model_creation_programmatic"));
        } else if (approach === "import") {
            result.push(await readPrompt("model_creation_import"));
        }

        return {
            messages: [
                {
                    role: "user" as const,
                    content: {
                        type: "text" as const,
                        text: result.join("\n")
                    }
                }
            ]
        };
    }
});

export default prompts;
