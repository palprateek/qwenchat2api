/**
 * Session Manager
 *
 * Manages conversation persistence and chat session mapping
 * between OpenAI conversation IDs and Qwen chat IDs.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('session');

interface SessionMapping {
  openaiId: string;
  qwenChatId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  lastParentId: string | null;
}

export class SessionManager {
  private sessions: Map<string, SessionMapping> = new Map();
  private dataDir: string;
  private dirty: boolean = false;

  constructor() {
    this.dataDir = process.env.DATA_DIR || './data';
    this.load();
  }

  /**
   * Create a new session mapping
   */
  createSession(openaiId: string, qwenChatId: string, model: string): void {
    this.sessions.set(openaiId, {
      openaiId,
      qwenChatId,
      model,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      lastParentId: null,
    });
    this.dirty = true;
    logger.debug(`Session created: ${openaiId} → ${qwenChatId}`);
  }

  /**
   * Get the Qwen chat ID for an OpenAI conversation ID
   */
  getQwenChatId(openaiId: string): string | undefined {
    const session = this.sessions.get(openaiId);
    if (session) {
      session.lastUsedAt = Date.now();
      session.messageCount++;
      this.dirty = true;
      return session.qwenChatId;
    }
    return undefined;
  }

  updateLastParentId(openaiId: string, parentId: string): void {
    const session = this.sessions.get(openaiId);
    if (session) {
      session.lastParentId = parentId;
      this.dirty = true;
    }
  }

  /**
   * Get the session mapping
   */
  getSession(openaiId: string): SessionMapping | undefined {
    return this.sessions.get(openaiId);
  }

  /**
   * Remove a session
   */
  removeSession(openaiId: string): void {
    this.sessions.delete(openaiId);
    this.dirty = true;
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionMapping[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clean up old sessions (older than maxAgeMs)
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastUsedAt > maxAgeMs) {
        this.sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.dirty = true;
      logger.info(`Cleaned up ${removed} expired sessions`);
    }

    return removed;
  }

  /**
   * Persist sessions to disk
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      const data = Array.from(this.sessions.values());
      const stateFile = path.join(this.dataDir, 'sessions.json');
      fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), { mode: 0o600 });
      this.dirty = false;
      logger.debug('Sessions persisted to disk');
    } catch (err) {
      logger.error('Failed to persist sessions', { error: (err as Error).message });
    }
  }

  /**
   * Load sessions from disk
   */
  private load(): void {
    const stateFile = path.join(this.dataDir, 'sessions.json');

    if (!fs.existsSync(stateFile)) return;

    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const data = JSON.parse(raw) as SessionMapping[];

      for (const session of data) {
        this.sessions.set(session.openaiId, session);
      }

      logger.info(`Loaded ${this.sessions.size} persisted sessions`);
    } catch (err) {
      logger.warn('Failed to load sessions', { error: (err as Error).message });
    }
  }
}
