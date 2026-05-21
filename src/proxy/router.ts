/**
 * OpenAI-Compatible Proxy Router
 *
 * Handles incoming OpenAI-format requests and routes them
 * through the Qwen client with proper translation.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { QwenClient } from '../client/qwen-client';
import { AuthManager } from '../auth/auth-manager';
import { RateLimiter } from '../utils/rate-limiter';
import { createProxyError } from '../utils/error-handler';
import { ToolCallTranslator } from '../tools/tool-translator';
import { OpenAICompat } from './openai-compat';
import { SessionManager } from '../session/session-manager';

const logger = createLogger('proxy');

export class ProxyRouter {
  private router: Router;
  private qwenClient: QwenClient;
  private authManager: AuthManager;
  private rateLimiter: RateLimiter;
  private sessionManager: SessionManager;
  private toolTranslator: ToolCallTranslator;
  private openaiCompat: OpenAICompat;

  constructor(
    qwenClient: QwenClient,
    authManager: AuthManager,
    rateLimiter: RateLimiter,
    sessionManager: SessionManager
  ) {
    this.router = Router();
    this.qwenClient = qwenClient;
    this.authManager = authManager;
    this.rateLimiter = rateLimiter;
    this.sessionManager = sessionManager;
    this.toolTranslator = new ToolCallTranslator();
    this.openaiCompat = new OpenAICompat(qwenClient, this.toolTranslator, sessionManager);

    this.registerRoutes();
  }

  getRouter(): Router {
    return this.router;
  }

  private registerRoutes(): void {
    // GET /v1/models - List available models
    this.router.get('/v1/models', this.handleModels.bind(this));

    // POST /v1/chat/completions - Chat completions
    this.router.post('/v1/chat/completions', this.handleChatCompletions.bind(this));

    // DELETE /v1/chats/:chatId - Delete a chat session
    this.router.delete('/v1/chats/:chatId', this.handleDeleteChat.bind(this));

    // POST /v1/auth/refresh - Refresh auth credentials
    this.router.post('/v1/auth/refresh', this.handleAuthRefresh.bind(this));
  }

  /**
   * GET /v1/models
   */
  private async handleModels(_req: Request, res: Response): Promise<void> {
    try {
      const models = this.qwenClient.getModelsList();
      res.json({
        object: 'list',
        data: models,
      });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * POST /v1/chat/completions
   */
  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = uuidv4();

    try {
      // Rate limiting
      const rateCheck = this.rateLimiter.check(req.ip || 'unknown');
      if (!rateCheck.allowed) {
        res.set({
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateCheck.resetAt.toString(),
        });
        throw createProxyError(
          'Rate limit exceeded',
          429,
          'RATE_LIMITED',
          true
        );
      }

      res.set({
        'X-RateLimit-Remaining': rateCheck.remaining.toString(),
        'X-RateLimit-Reset': rateCheck.resetAt.toString(),
      });

      // Validate request
      const { model, messages, stream, tools, temperature, max_tokens } =
        this.validateRequest(req.body);

      logger.info(`Chat completion request`, {
        requestId,
        model,
        messagesCount: messages.length,
        stream,
        hasTools: !!tools?.length,
      });

      const modelId = this.qwenClient.resolveModelId(model);

      // Handle tools: inject tool definitions into system prompt if present
      const processedMessages = this.toolTranslator.injectToolDefinitions(
        messages,
        tools
      );

      // Extract or auto-generate conversation ID for session reuse
      let conversationId = req.headers['x-conversation-id'] as string | undefined;
      if (!conversationId) {
        // Auto-generate from client IP so all requests from same client reuse the session
        conversationId = `auto:${req.ip || 'unknown'}:${modelId}`;
        logger.debug('Auto-generated conversationId', { conversationId });
      }

      if (req.body.stream) {
        await this.openaiCompat.handleStreamingCompletion(
          req,
          res,
          {
            model,
            modelId,
            messages: processedMessages,
            tools,
            stream: true,
            temperature,
            max_tokens,
            conversationId,
          },
          requestId
        );
      } else {
        await this.openaiCompat.handleNonStreamingCompletion(
          req,
          res,
          {
            model,
            modelId,
            messages: processedMessages,
            tools,
            stream: false,
            temperature,
            max_tokens,
            conversationId,
          },
          requestId
        );
      }

      logger.info(`Chat completion finished`, {
        requestId,
        duration: Date.now() - startTime,
        stream: !!req.body.stream,
      });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * DELETE /v1/chats/:chatId
   */
  private async handleDeleteChat(req: Request, res: Response): Promise<void> {
    try {
      const { chatId } = req.params;
      await this.qwenClient.deleteChat(chatId);
      res.json({ success: true, chatId });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * POST /v1/auth/refresh
   */
  private async handleAuthRefresh(_req: Request, res: Response): Promise<void> {
    try {
      const valid = await this.authManager.refreshToken();
      res.json({
        success: valid,
        status: this.authManager.getStatus(),
      });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * Validate and extract fields from the request body
   */
  private validateRequest(body: any): {
    model: string;
    messages: any[];
    stream: boolean;
    tools?: any[];
    temperature?: number;
    max_tokens?: number;
  } {
    if (!body) {
      throw createProxyError('Request body is required', 400, 'INVALID_REQUEST');
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw createProxyError(
        'messages must be a non-empty array',
        400,
        'INVALID_REQUEST'
      );
    }

    return {
      model: body.model || 'qwen-max-latest',
      messages: body.messages,
      stream: body.stream || false,
      tools: body.tools,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };
  }

  private sendError(res: Response, err: any): void {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'PROXY_ERROR';
    const message = err.message || 'Internal server error';

    logger.error(`Request error: ${message}`, { code, statusCode });

    if (!res.headersSent) {
      res.status(statusCode).json({
        error: {
          message,
          type: code,
          code: statusCode,
        },
      });
    }
  }
}
