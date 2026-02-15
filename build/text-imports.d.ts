/**
 * Type declarations for importing text files as strings
 * These are processed by the text-file-loader plugin in build.ts
 */

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.svg" {
  const content: string;
  export default content;
}
