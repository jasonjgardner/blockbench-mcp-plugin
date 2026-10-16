import type { z } from "zod";

export type StatusType = "stable" | "experimental";

export interface IMCPTool {
  name: string;
  description: string;
  enabled: boolean;
  status: StatusType;
  /** Owning plugin id for tools contributed by another Blockbench plugin; absent for built-in tools. */
  plugin?: string;
}

export interface IMCPPrompt {
  name: string;
  description: string;
  arguments: z.ZodRawShape;
  enabled: boolean;
  status: StatusType;
}

export interface IMCPResource {
  name: string;
  description: string;
  uriTemplate: string;
}
