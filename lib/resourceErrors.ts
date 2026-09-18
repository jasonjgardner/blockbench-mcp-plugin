import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Creates the JSON-RPC Invalid Params error required for an unavailable resource.
 *
 * @param uri - The requested resource URI, included in error data for recovery.
 * @param message - An actionable explanation, without replacing the protocol code.
 * @returns A protocol error to throw from a resource read callback.
 */
export function resourceNotFound(uri: URL | string, message = "Resource not found."): McpError {
  return new McpError(ErrorCode.InvalidParams, message, { uri: String(uri) });
}

/**
 * Preserves explicit MCP errors and converts unexpected resource failures to Internal Error.
 *
 * @param operation - A resource list or read operation; synchronous throws are also caught.
 * @param uri - The requested URI for reads; omit for resource listing.
 * @returns The operation's original result, or rejects with a JSON-RPC error.
 */
export async function withResourceErrors<T>(operation: () => T | Promise<T>, uri?: URL | string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : "An unexpected resource operation failed.";
    throw new McpError(ErrorCode.InternalError, message, uri ? { uri: String(uri) } : undefined);
  }
}
