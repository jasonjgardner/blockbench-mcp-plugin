import packageJson from "../package.json" assert { type: "json" };

export const VERSION = packageJson.version;
export const STATUS_STABLE = "stable";
export const STATUS_EXPERIMENTAL = "experimental";
