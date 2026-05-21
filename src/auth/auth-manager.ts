/**
 * Authentication Manager
 *
 * Handles Bearer token and cookie management for chat.qwen.ai.
 * Supports:
 * - Token extraction from environment variables
 * - Cookie/session persistence to disk
 * - Auto-refresh of expired sessions
 * - Health status reporting
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';
import { createProxyError } from '../utils/error-handler';

const logger = createLogger('auth');

export interface AuthState {
  token: string;
  cookie: string;
  userId?: string;
  obtainedAt: number;
  expiresAt?: number;
}

const AUTH_STATE_FILE = 'auth_state.json';

export class AuthManager {
  private state: AuthState | null = null;
  private dataDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.dataDir = process.env.DATA_DIR || './data';
  }

  async initialize(): Promise<void> {
    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Try to load persisted auth state
    const stateFile = path.join(this.dataDir, AUTH_STATE_FILE);
    if (fs.existsSync(stateFile)) {
      try {
        const raw = fs.readFileSync(stateFile, 'utf-8');
        this.state = JSON.parse(raw);
        logger.info('Loaded persisted auth state', {
          hasToken: !!this.state?.token,
          hasCookie: !!this.state?.cookie,
          age: this.state ? Date.now() - this.state.obtainedAt : 0,
        });
      } catch (e) {
        logger.warn('Failed to load auth state, will use env vars', { error: (e as Error).message });
      }
    }

    // Fall back to environment variables
    if (!this.state?.token && process.env.QWEN_AUTH_TOKEN) {
      this.state = {
        token: process.env.QWEN_AUTH_TOKEN,
        cookie: process.env.QWEN_COOKIE || '',
        obtainedAt: Date.now(),
      };
      logger.info('Loaded auth from environment variables');
    }

    if (!this.state?.token) {
      logger.warn(
        'No auth credentials found. Set QWEN_AUTH_TOKEN and QWEN_COOKIE in .env or run: npm run login'
      );
    }

    // Schedule periodic auth refresh
    this.scheduleRefresh();
  }

  getToken(): string {
    if (!this.state?.token) {
      throw createProxyError(
        'No auth token available. Set QWEN_AUTH_TOKEN or run: npm run login',
        401,
        'AUTH_REQUIRED',
        false
      );
    }
    return this.state.token;
  }

  getCookie(): string {
    return this.state?.cookie || '';
  }

  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.getToken()}`,
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'DNT': '1',
      'Origin': 'https://chat.qwen.ai',
      'Referer': 'https://chat.qwen.ai/',
      'Host': 'chat.qwen.ai',
    };

    if (this.state?.cookie) {
      headers['Cookie'] = this.state.cookie;
    }

    return headers;
  }

  getStreamHeaders(): Record<string, string> {
    const headers = this.getAuthHeaders();
    // Remove Accept-Encoding to avoid compressed SSE stream
    delete headers['Accept-Encoding'];
    // Override Accept for SSE
    headers['Accept'] = 'text/event-stream';
    headers['X-Accel-Buffering'] = 'no';
    return headers;
  }

  async updateAuth(token: string, cookie: string, userId?: string): Promise<void> {
    this.state = {
      token,
      cookie,
      userId,
      obtainedAt: Date.now(),
    };
    this.persist();
    logger.info('Auth credentials updated');
  }

  async refreshToken(): Promise<boolean> {
    if (!this.state?.token) {
      return false;
    }

    try {
      // Attempt to validate current token by fetching user info
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('https://chat.qwen.ai/api/v1/auths/', {
        headers: this.getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (this.state) {
          this.state.userId = data?.id;
          this.persist();
        }
        logger.info('Token validation successful');
        return true;
      }

      if (response.status === 401 || response.status === 403) {
        logger.warn('Token expired or invalid');
        return false;
      }

      logger.warn('Token validation returned unexpected status', {
        status: response.status,
      });
      return false;
    } catch (err) {
      logger.error('Token refresh check failed', { error: (err as Error).message });
      return false;
    }
  }

  getStatus(): {
    authenticated: boolean;
    hasToken: boolean;
    hasCookie: boolean;
    userId?: string;
    tokenAge: number;
  } {
    return {
      authenticated: !!this.state?.token,
      hasToken: !!this.state?.token,
      hasCookie: !!this.state?.cookie,
      userId: this.state?.userId,
      tokenAge: this.state ? Date.now() - this.state.obtainedAt : 0,
    };
  }

  private persist(): void {
    if (!this.state) return;
    const stateFile = path.join(this.dataDir, AUTH_STATE_FILE);
    try {
      fs.writeFileSync(stateFile, JSON.stringify(this.state, null, 2), {
        mode: 0o600, // Owner read/write only
      });
    } catch (err) {
      logger.error('Failed to persist auth state', { error: (err as Error).message });
    }
  }

  private scheduleRefresh(): void {
    // Check token validity every 10 minutes
    const INTERVAL = 10 * 60 * 1000;
    this.refreshTimer = setInterval(async () => {
      const valid = await this.refreshToken();
      if (!valid) {
        logger.warn(
          'Token may be expired. Please update credentials via .env or: npm run login'
        );
      }
    }, INTERVAL);
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }
}
