export { default as server } from "./server";
export * as tools from "./tools";
// Import resources.ts for side effects (registers resources via createResource)
import "./resources";
// Re-export the resources registry from factories
export { resources } from "@/lib/factories";
export { default as prompts } from "./prompts";