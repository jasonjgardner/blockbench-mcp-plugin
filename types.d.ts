import type { ToolParameters, Tool, Prompt, PromptArgument } from "fastmcp";

export interface IMCPTool {
  name: string;
  description: string;
  enabled: boolean;
}

export interface IMCPPrompt {
  name: string;
  description: string;
  arguments: PromptArgument[];
  enabled: boolean;
}

export interface IMCPResource {
  name: string;
  description: string;
}