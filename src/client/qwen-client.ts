/**
 * Qwen API Client
 *
 * Handles all communication with chat.qwen.ai backend,
 * including request translation, payload mapping, and
 * response parsing.
 */

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { AuthManager } from '../auth/auth-manager';
import { SessionManager } from '../session/session-manager';
import { createProxyError } from '../utils/error-handler';
import { QWEN_MODEL_MAP, ModelInfo, resolveModel } from './models';

const logger = createLogger('qwen-client');

const QWEN_BASE_URL = 'https://chat.qwen.ai';

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant' | 'system';
  content: string;
  user_action?: string;
  files?: any[];
  timestamp: number;
  models?: string[];
  chat_type: string;
  feature_config: {
    output_schema: string | null;
    thinking_enabled: boolean;
    thinking_budget?: number;
  };
  extra: Record<string, any>;
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenCompletionPayload {
  stream: boolean;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface QwenCreateChatPayload {
  title: string;
  models: string[];
  chat_mode: string;
  chat_type: string;
  timestamp: number;
}

export class QwenClient {
  private authManager: AuthManager;
  private sessionManager: SessionManager;
  private modelsInfo: Map<string, ModelInfo> = new Map();
  private userSettings: any = null;

  constructor(authManager: AuthManager, sessionManager: SessionManager) {
    this.authManager = authManager;
    this.sessionManager = sessionManager;
  }

  async initialize(): Promise<void> {
    try {
      await this.fetchModels();
    } catch (err) {
      logger.warn('Failed to fetch models on init, using defaults', {
        error: (err as Error).message,
      });
      this.loadDefaultModels();
    }

    try {
      await this.fetchUserSettings();
    } catch (err) {
      logger.warn('Failed to fetch user settings', { error: (err as Error).message });
    }
  }

  /**
   * Fetch available models from chat.qwen.ai
   */
  async fetchModels(): Promise<void> {
    const response = await this.makeRequest('GET', '/api/models');
    if (response.ok) {
      const data = (await response.json()) as any;
      const models = data?.data || [];
      this.modelsInfo.clear();
      for (const model of models) {
        if (model.id) {
          this.modelsInfo.set(model.id, {
            id: model.id,
            info: model.info || '',
            capabilities: model.capabilities || {},
          });
        }
      }
      logger.info(`Fetched ${this.modelsInfo.size} models from chat.qwen.ai`);
    } else {
      throw createProxyError(
        `Failed to fetch models: ${response.status}`,
        response.status,
        'MODEL_FETCH_ERROR',
        true
      );
    }
  }

  /**
   * Fetch user settings (includes thinking_budget defaults)
   */
  async fetchUserSettings(): Promise<void> {
    const response = await this.makeRequest('GET', '/api/v2/users/user/settings');
    if (response.ok) {
      this.userSettings = await response.json();
      logger.debug('Fetched user settings');
    }
  }

  /**
   * Create a new chat session on chat.qwen.ai
   */
  async createChat(modelId: string): Promise<string> {
    const payload: QwenCreateChatPayload = {
      title: 'New Chat',
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
    };

    const response = await this.makeRequest(
      'POST',
      '/api/v2/chats/new',
      payload
    );

    if (!response.ok) {
      const text = await response.text();
      throw createProxyError(
        `Failed to create chat: ${response.status} - ${text}`,
        response.status,
        'CHAT_CREATE_ERROR',
        response.status >= 500
      );
    }

    const data = (await response.json()) as any;
    const chatId = data?.data?.id;

    if (!chatId) {
      throw createProxyError(
        'No chat_id returned from create chat',
        500,
        'CHAT_CREATE_ERROR',
        true
      );
    }

    logger.debug(`Created chat session: ${chatId}`);
    return chatId;
  }

  /**
   * Send a completion request to chat.qwen.ai and get a streaming response
   */
  async streamCompletion(
    chatId: string,
    modelId: string,
    messages: QwenMessage[],
    options?: {
      thinkingEnabled?: boolean;
      thinkingBudget?: number;
      parentId?: string | null;
    }
  ): Promise<fetch.Response> {
    const payload: QwenCompletionPayload = {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: options?.parentId || null,
      messages,
      timestamp: Date.now(),
    };

    // Apply thinking settings
    if (options?.thinkingEnabled) {
      for (const msg of payload.messages) {
        if (msg.role === 'user') {
          msg.feature_config.thinking_enabled = true;
          if (options.thinkingBudget) {
            msg.feature_config.thinking_budget = options.thinkingBudget;
          }
        }
      }
    }

    const headers = this.authManager.getStreamHeaders();
    const url = `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`;

    logger.debug(`Sending streaming completion`, {
      model: modelId,
      messagesCount: messages.length,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeout: parseInt(process.env.REQUEST_TIMEOUT || '120000', 10),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`Completion request failed: ${response.status}`, { body: text });

      if (response.status === 401 || response.status === 403) {
        throw createProxyError(
          'Authentication failed. Token may be expired.',
          response.status,
          'AUTH_EXPIRED',
          false
        );
      }

      if (response.status === 429) {
        throw createProxyError(
          'Rate limited by chat.qwen.ai',
          429,
          'RATE_LIMITED',
          true
        );
      }

      throw createProxyError(
        `Completion request failed: ${response.status} - ${text}`,
        response.status,
        'COMPLETION_ERROR',
        response.status >= 500
      );
    }

    // Check if response is actually an error (200 OK but error body)
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const bodyText = await response.text();
      logger.error('Non-SSE response from Qwen', { status: response.status, contentType, body: bodyText.slice(0, 1000) });
      throw createProxyError(
        `Qwen returned non-SSE response: ${bodyText.slice(0, 500)}`,
        500,
        'INVALID_RESPONSE_FORMAT',
        true
      );
    }

    return response;
  }

  /**
   * Get the full chat content after completion (for non-streaming fallback)
   */
  async getChatContent(chatId: string): Promise<any> {
    const response = await this.makeRequest('GET', `/api/v2/chats/${chatId}`);

    if (!response.ok) {
      throw createProxyError(
        `Failed to get chat content: ${response.status}`,
        response.status,
        'CHAT_FETCH_ERROR',
        true
      );
    }

    return response.json();
  }

  /**
   * Delete a chat session
   */
  async deleteChat(chatId: string): Promise<void> {
    const response = await this.makeRequest('DELETE', `/api/v2/chats/${chatId}`);
    if (response.ok) {
      logger.debug(`Deleted chat: ${chatId}`);
    }
  }

  /**
   * Get the list of available models in OpenAI format
   */
  getModelsList(): { id: string; object: string; created: number; owned_by: string }[] {
    const models: { id: string; object: string; created: number; owned_by: string }[] = [];

    // Add all fetched models
    for (const [id, info] of this.modelsInfo.entries()) {
      models.push({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'qwen',
      });
    }

    // Add mapped models that aren't already present
    for (const [alias, modelId] of Object.entries(QWEN_MODEL_MAP)) {
      if (!this.modelsInfo.has(alias) && !models.find((m) => m.id === alias)) {
        models.push({
          id: alias,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'qwen',
        });
      }
    }

    return models;
  }

  /**
   * Resolve a model name to the actual chat.qwen.ai model ID
   */
  resolveModelId(requestedModel: string): string {
    return resolveModel(requestedModel, this.modelsInfo);
  }

  /**
   * Build a Qwen message from OpenAI message format
   */
  buildQwenMessage(
    role: 'user' | 'assistant' | 'system',
    content: string,
    modelId: string,
    options?: {
      thinkingEnabled?: boolean;
      thinkingBudget?: number;
    }
  ): QwenMessage {
    const featureConfig: QwenMessage['feature_config'] = {
      output_schema: null,
      thinking_enabled: options?.thinkingEnabled || false,
    };
    // Only include thinking_budget when thinking is enabled and budget > 0
    if (options?.thinkingEnabled && options?.thinkingBudget && options.thinkingBudget > 0) {
      featureConfig.thinking_budget = options.thinkingBudget;
    }

    return {
      fid: uuidv4(),
      parentId: null,
      childrenIds: [],
      role,
      content,
      user_action: role === 'user' ? 'chat' : undefined,
      files: [],
      timestamp: Date.now(),
      models: [modelId],
      chat_type: 't2t',
      feature_config: featureConfig,
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    };
  }

  /**
   * Make an authenticated request to chat.qwen.ai
   */
  private async makeRequest(
    method: string,
    path: string,
    body?: any
  ): Promise<fetch.Response> {
    const headers = this.authManager.getAuthHeaders();
    const url = `${QWEN_BASE_URL}${path}`;

    const options: fetch.RequestInit = {
      method,
      headers,
      timeout: 30000,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    return fetch(url, options);
  }

  /**
   * Load default model list if API fetch fails
   */
  private loadDefaultModels(): void {
    const defaultModels = [
      'qwen-max-latest',
      'qwen3-max-preview',
      'qwen3-235b-a22b',
      'qwen3-coder-plus',
      'qwen3-30b-a3b',
      'qwen-plus-2025-09-11',
      'qwen-turbo-2025-02-11',
      'qwq-32b',
      'qwen3-vl-plus',
    ];

    for (const id of defaultModels) {
      this.modelsInfo.set(id, { id, info: '', capabilities: {} });
    }
    logger.info(`Loaded ${defaultModels.length} default models`);
  }
}
