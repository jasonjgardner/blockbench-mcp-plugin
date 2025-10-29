/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";

/**
 * Check if an Edit Session is active
 */
function getActiveEditSession(): EditSession | null {
  if (!Project || !Project.EditSession || !Project.EditSession.active) {
    return null;
  }
  return Project.EditSession;
}

/**
 * Send a custom command through the Edit Session
 */
createTool(
  "edit_session_send_command",
  {
    description:
      "Send a custom command through an active Edit Session. The command will be broadcast to all connected clients in the session. Requires an active Edit Session.",
    annotations: {
      title: "Edit Session: Send Command",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      command: z
        .enum(["undo", "redo", "quit_session"])
        .describe(
          "The command to send. 'undo' undoes the last action, 'redo' redoes the last undone action, 'quit_session' closes the session for all clients."
        ),
    }),
    async execute({ command }) {
      const session = getActiveEditSession();

      if (!session) {
        throw new Error(
          "No active Edit Session. Start or join an Edit Session first."
        );
      }

      if (!session.hosting) {
        throw new Error(
          "Only the host can send commands. This client is not hosting the session."
        );
      }

      session.sendAll("command", command);

      return `Command "${command}" sent to all clients in the Edit Session.`;
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Send custom data through the Edit Session
 */
createTool(
  "edit_session_send_data",
  {
    description:
      "Send custom data through an active Edit Session with a specified type. The data will be broadcast to all connected clients. Requires an active Edit Session and host privileges.",
    annotations: {
      title: "Edit Session: Send Custom Data",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      type: z
        .string()
        .describe(
          "The type identifier for the data being sent (e.g., 'custom_action', 'mcp_command')"
        ),
      data: z
        .any()
        .describe(
          "The data payload to send. Can be any JSON-serializable value (string, number, object, array, etc.)"
        ),
    }),
    async execute({ type, data }) {
      const session = getActiveEditSession();

      if (!session) {
        throw new Error(
          "No active Edit Session. Start or join an Edit Session first."
        );
      }

      if (!session.hosting) {
        throw new Error(
          "Only the host can send data. This client is not hosting the session."
        );
      }

      const reservedTypes = [
        "edit",
        "init_model",
        "command",
        "chat_message",
        "chat_input",
        "client_count",
        "change_project_meta",
      ];
      if (reservedTypes.includes(type)) {
        throw new Error(
          `Type "${type}" is reserved by Blockbench. Please use a custom type identifier.`
        );
      }

      session.sendAll(type, data);

      return `Custom data sent to all clients in the Edit Session. Type: "${type}"`;
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Get Edit Session status
 */
createTool(
  "edit_session_status",
  {
    description:
      "Get the current status of the Edit Session, including whether a session is active, hosting status, client count, and session token.",
    annotations: {
      title: "Edit Session: Get Status",
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({}),
    async execute() {
      const session = getActiveEditSession();

      if (!session) {
        return {
          active: false,
          message: "No active Edit Session.",
        };
      }

      return {
        active: session.active,
        hosting: session.hosting,
        client_count: session.client_count,
        token: session.token || null,
        username: session.username || null,
        has_project: !!session.Project,
      };
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Start an Edit Session
 */
createTool(
  "edit_session_start",
  {
    description:
      "Start a new Edit Session as the host. This creates a P2P connection that other users can join. Returns the session token that others can use to join.",
    annotations: {
      title: "Edit Session: Start (Host)",
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters: z.object({
      username: z
        .string()
        .optional()
        .describe("Username to use in the session. If not provided, a random name will be assigned."),
    }),
    async execute({ username }) {
      if (!Project) {
        throw new Error(
          "No project is open. Create or open a project before starting an Edit Session."
        );
      }

      const existingSession = getActiveEditSession();
      if (existingSession) {
        throw new Error(
          `An Edit Session is already active. Token: ${existingSession.token}`
        );
      }

      const session = new EditSession();
      
      return new Promise((resolve, reject) => {
        session.start(username);
        
        const checkToken = setInterval(() => {
          if (session.token) {
            clearInterval(checkToken);
            resolve({
              success: true,
              token: session.token,
              username: session.username,
              message: `Edit Session started. Share this token with others to let them join: ${session.token}`,
            });
          }
        }, 100);
        
        setTimeout(() => {
          clearInterval(checkToken);
          if (!session.token) {
            reject(new Error("Failed to start Edit Session: timeout waiting for token"));
          }
        }, 10000);
      });
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Join an Edit Session
 */
createTool(
  "edit_session_join",
  {
    description:
      "Join an existing Edit Session using a token. This connects to a host's session as a client.",
    annotations: {
      title: "Edit Session: Join",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({
      token: z
        .string()
        .length(16)
        .describe("The 16-character session token provided by the host"),
      username: z
        .string()
        .optional()
        .describe("Username to use in the session. If not provided, a random name will be assigned."),
    }),
    async execute({ token, username }) {
      const existingSession = getActiveEditSession();
      if (existingSession) {
        throw new Error(
          "An Edit Session is already active. Quit the current session before joining another."
        );
      }

      const session = new EditSession();
      
      return new Promise((resolve, reject) => {
        session.join(username || "", token);
        
        const checkActive = setInterval(() => {
          if (session.active) {
            clearInterval(checkActive);
            resolve({
              success: true,
              token: session.token,
              username: session.username,
              hosting: session.hosting,
              message: `Successfully joined Edit Session.`,
            });
          }
        }, 100);
        
        setTimeout(() => {
          clearInterval(checkActive);
          if (!session.active) {
            reject(new Error("Failed to join Edit Session: timeout or invalid token"));
          }
        }, 10000);
      });
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Quit the Edit Session
 */
createTool(
  "edit_session_quit",
  {
    description:
      "Quit the current Edit Session. If hosting, this will close the session for all clients. If joined as a client, this will disconnect from the host.",
    annotations: {
      title: "Edit Session: Quit",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: z.object({}),
    async execute() {
      const session = getActiveEditSession();

      if (!session) {
        throw new Error("No active Edit Session to quit.");
      }

      const wasHosting = session.hosting;
      session.quit();

      if (wasHosting) {
        return "Edit Session closed. All clients have been disconnected.";
      } else {
        return "Disconnected from Edit Session.";
      }
    },
  },
  STATUS_EXPERIMENTAL
);

/**
 * Send a chat message through the Edit Session
 */
createTool(
  "edit_session_send_chat",
  {
    description:
      "Send a chat message through the Edit Session. The message will be visible to all connected clients in the chat panel.",
    annotations: {
      title: "Edit Session: Send Chat Message",
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: z.object({
      message: z
        .string()
        .max(512)
        .describe("The chat message to send (max 512 characters)"),
    }),
    async execute({ message }) {
      const session = getActiveEditSession();

      if (!session) {
        throw new Error(
          "No active Edit Session. Start or join an Edit Session first."
        );
      }

      session.sendChat(message);

      return `Chat message sent: "${message}"`;
    },
  },
  STATUS_EXPERIMENTAL
);
