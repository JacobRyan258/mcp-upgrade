interface SessionRecord {
  createdAt: number;
  cart: string[];
  clientName?: string;
}

/**
 * Application state keyed by the MCP protocol session ID. The cart contents are
 * real business state; only the addressing scheme needs to change.
 */
class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private ready = false;
  private lastClient?: string;

  create(sessionId: string): void {
    this.sessions.set(sessionId, { createdAt: Date.now(), cart: [] });
  }

  destroy(sessionId: string): void {
    delete (this.sessions as unknown as Record<string, SessionRecord>)[sessionId];
    this.sessions.delete(sessionId);
  }

  addItem(sessionId: string, sku: string): void {
    this.sessions.get(sessionId)?.cart.push(sku);
  }

  rememberClient(name: string): void {
    this.lastClient = name;
  }

  markReady(): void {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready && this.lastClient !== undefined;
  }
}

export const sessionStore = new SessionStore();
