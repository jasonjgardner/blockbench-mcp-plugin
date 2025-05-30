import { createPrompt, prompts } from "@/lib/factories";
import { readPrompt } from "@/macros/readPrompt" with { type: 'macro' };

createPrompt("model_creation_strategy", {
    description: "A strategy for creating a new 3D model in Blockbench.",
    arguments: [
        {
            name: "format",
            description: "The format of the model to create.",
            required: false,
            enum: ["java_block", "bedrock"]
        }
    ],
    load: async (args) => {
        const { format } = args;
        if (format === "java_block") {
            return readPrompt("java_block");
        }
        
        if (format === "bedrock") {
            return readPrompt("bedrock_block");
        }

        return "Create a new model in Blockbench.";
    }
})

export default prompts;