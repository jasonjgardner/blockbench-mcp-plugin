import { createPrompt, prompts } from "@/lib/factories";
import { readPrompt } from "@/macros/readPrompt" with { type: 'macro' };

createPrompt("model_creation_strategy", {
    description: "A strategy for creating a new 3D model in Blockbench.",
    arguments: [
        {
            name: "format",
            description: "The format of the model to create.",
            required: false,
            enum: ["java_block", "bedrock"],
            complete: async (value) => {
                if (value.startsWith("java")) {
                    return { values: ["java_block"] };
                }
                if (value.startsWith("b")) {
                    return { values: ["bedrock"] };
                }
                return { values: ["java_block", "bedrock"] };
            }
        },
        {
            name: "approach",
            description: "The approach to use for creating the model.",
            required: false,
            enum: ["ui", "programmatic", "import"],
            complete: async (value) => {
                if (value.startsWith("u")) {
                    return { values: ["ui"] };
                }
                if (value.startsWith("p")) {
                    return { values: ["programmatic"] };
                }
                if (value.startsWith("i")) {
                    return { values: ["import"] };
                }
                return { values: ["ui", "programmatic", "import"] };
            }
        }
    ],
    load: async (args) => {
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

        return result.join("\n");
    }
});

export default prompts;