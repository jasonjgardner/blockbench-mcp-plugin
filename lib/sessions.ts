const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface Session {
  id: string;
  connectedAt: Date;
  lastActivity: Date;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Client name from MCP initialize request (e.g., "Claude Code", "Cline") */
  clientName?: string;
  /** Client version from MCP initialize request */
  clientVersion?: string;
}

type SessionListener = (sessions: Session[]) => void;
type RemovalCallback = (sessionId: string) => void;

class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<SessionListener> = new Set();
  private removalCallback: RemovalCallback | null = null;

  add(sessionId: string): void {
    // Don't add duplicate sessions
    if (this.sessions.has(sessionId)) {
      this.updateActivity(sessionId);
      return;
    }

    const session: Session = {
      id: sessionId,
      connectedAt: new Date(),
      lastActivity: new Date(),
    };
    this.resetTimeout(session);
    this.sessions.set(sessionId, session);
    this.notifyListeners();

    console.log(`[MCP] Session connected: ${sessionId.slice(0, 8)}...`);
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }

    // Delete from map FIRST to prevent re-entrancy issues
    // (e.g., if removalCallback triggers onsessionclosed which calls remove() again)
    this.sessions.delete(sessionId);
    this.notifyListeners();

    console.log(`[MCP] Session disconnected: ${sessionId.slice(0, 8)}...`);

    // Notify removal callback (e.g., to close transport) after removing from map
    if (this.removalCallback) {
      try {
        this.removalCallback(sessionId);
      } catch (error) {
        console.error("[MCP] Session removal callback error:", error);
      }
    }
  }

  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      this.resetTimeout(session);
    }
  }

  updateClientInfo(sessionId: string, clientName?: string, clientVersion?: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientName = clientName;
      session.clientVersion = clientVersion;
      this.notifyListeners();
      const displayName = clientName || sessionId.slice(0, 8) + '...';
      console.log(`[MCP] Session identified: ${displayName}${clientVersion ? ` v${clientVersion}` : ''}`);
    }
  }

  private resetTimeout(session: Session): void {
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }
    session.timeoutHandle = setTimeout(() => {
      console.log(`[MCP] Session timed out: ${session.id.slice(0, 8)}...`);
      this.remove(session.id);
    }, INACTIVITY_TIMEOUT_MS);
  }

  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  getCount(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    // Immediately call with current state
    listener(this.getAll());
    return () => this.listeners.delete(listener);
  }

  /**
   * Sets a callback to be invoked when a session is removed (timeout or explicit).
   * Used to synchronize transport cleanup with session removal.
   */
  setRemovalCallback(callback: RemovalCallback | null): void {
    this.removalCallback = callback;
  }

  private notifyListeners(): void {
    const sessions = this.getAll();
    this.listeners.forEach((listener) => {
      try {
        listener(sessions);
      } catch (error) {
        console.error("[MCP] Session listener error:", error);
      }
    });
  }

  /**
   * Clears all sessions and timeouts. Used during plugin unload.
   */
  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.timeoutHandle) {
        clearTimeout(session.timeoutHandle);
      }
    }
    this.sessions.clear();
    this.listeners.clear();
  }
}

export const sessionManager = new SessionManager();
