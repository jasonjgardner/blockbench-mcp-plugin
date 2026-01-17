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

class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<SessionListener> = new Set();

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
    this.sessions.delete(sessionId);
    this.notifyListeners();

    console.log(`[MCP] Session disconnected: ${sessionId.slice(0, 8)}...`);
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
