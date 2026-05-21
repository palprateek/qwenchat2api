/**
 * OpenAI Compatibility Layer
 *
 * Translates between OpenAI API format and Qwen backend format,
 * handling both streaming and non-streaming completions.
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { QwenClient, QwenMessage } from '../client/qwen-client';
import { StreamAdapter } from '../streaming/stream-adapter';
import { ToolCallTranslator } from '../tools/tool-translator';
import { createProxyError } from '../utils/error-handler';
import { supportsThinking, getDefaultThinkingBudget } from '../client/models';
import { SessionManager } from '../session/session-manager';

const logger = createLogger('openai-compat');

interface CompletionParams {
  model: string;
  modelId: string;
  messages: any[];
  tools?: any[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  conversationId?: string;
}

export class OpenAICompat {
  private qwenClient: QwenClient;
  private toolTranslator: ToolCallTranslator;
  private sessionManager: SessionManager;

  constructor(qwenClient: QwenClient, toolTranslator: ToolCallTranslator, sessionManager: SessionManager) {
    this.qwenClient = qwenClient;
    this.toolTranslator = toolTranslator;
    this.sessionManager = sessionManager;
  }

  /**
   * Handle a streaming completion request
   */
  async handleStreamingCompletion(
    _req: Request,
    res: Response,
    params: CompletionParams,
    requestId: string
  ): Promise<void> {
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;

    // Session lookup for conversation reuse
    let chatId: string;
    let parentId: string | null = null;
    const qwenMessages: QwenMessage[] = [];

    if (params.conversationId) {
      const existingChatId = this.sessionManager.getQwenChatId(params.conversationId);
      if (existingChatId) {
        chatId = existingChatId;
        parentId = this.sessionManager.getSession(params.conversationId)?.lastParentId || null;
        const lastUserMsg = [...params.messages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg) {
          qwenMessages.push(
            this.qwenClient.buildQwenMessage('user', lastUserMsg.content, params.modelId, {
              thinkingEnabled: supportsThinking(params.modelId),
              thinkingBudget: getDefaultThinkingBudget(params.modelId),
            })
          );
        }
      } else {
        chatId = await this.qwenClient.createChat(params.modelId);
        this.sessionManager.createSession(params.conversationId, chatId, params.modelId);
        qwenMessages.push(...this.buildQwenMessages(params));
      }
    } else {
      chatId = await this.qwenClient.createChat(params.modelId);
      qwenMessages.push(...this.buildQwenMessages(params));
    }

    const thinkingEnabled = supportsThinking(params.modelId);
    const thinkingBudget = getDefaultThinkingBudget(params.modelId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const response = await this.qwenClient.streamCompletion(chatId, params.modelId, qwenMessages, {
        thinkingEnabled,
        thinkingBudget,
        parentId,
      });

      if (!response.body) {
        throw createProxyError('No response body from Qwen', 500, 'STREAM_ERROR');
      }

      const streamAdapter = new StreamAdapter();

      await streamAdapter.processStream(
        response.body,
        (chunk) => {
          const openaiChunks = this.translateStreamChunk(
            chunk,
            completionId,
            params.model,
            requestId
          );

          for (const openaiChunk of openaiChunks) {
            res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          }
        },
        async () => {
          const fullContent = streamAdapter.getAccumulatedContent();
          const toolCalls = this.toolTranslator.extractToolCalls(fullContent);

          if (toolCalls && toolCalls.length > 0) {
            const toolCallChunk = this.createToolCallChunk(
              toolCalls,
              completionId,
              params.model
            );
            res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
          }

          if (params.conversationId) {
            try {
              const chatData = await this.qwenClient.getChatContent(chatId);
              const messages = chatData?.data?.chat?.messages || [];
              const assistantMsg = messages.find((m: any) => m.role === 'assistant');
              if (assistantMsg?.fid) {
                this.sessionManager.updateLastParentId(params.conversationId!, assistantMsg.fid);
              }
            } catch (err) {
              logger.warn('Failed to extract parent_id after streaming', {
                error: (err as Error).message,
              });
            }
          }

          res.write('data: [DONE]\n\n');
          res.end();
        },
        (error) => {
          logger.error('Stream error', { error: error.message, requestId });
          const errorChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: params.model,
            choices: [
              {
                index: 0,
                delta: { content: `\n\n[Stream error: ${error.message}]` },
                finish_reason: 'stop',
              },
            ],
          };
          try {
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch {
          }
        }
      );
    } catch (err) {
      logger.error('Streaming completion failed', { error: (err as Error).message });
      if (!res.headersSent) {
        throw err;
      }
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
      }
    }
  }

  async handleNonStreamingCompletion(
    _req: Request,
    res: Response,
    params: CompletionParams,
    requestId: string
  ): Promise<void> {
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;

    let chatId: string;
    let parentId: string | null = null;
    const qwenMessages: QwenMessage[] = [];

    if (params.conversationId) {
      const existingChatId = this.sessionManager.getQwenChatId(params.conversationId);
      if (existingChatId) {
        chatId = existingChatId;
        parentId = this.sessionManager.getSession(params.conversationId)?.lastParentId || null;
        const lastUserMsg = [...params.messages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg) {
          qwenMessages.push(
            this.qwenClient.buildQwenMessage('user', lastUserMsg.content, params.modelId, {
              thinkingEnabled: supportsThinking(params.modelId),
              thinkingBudget: getDefaultThinkingBudget(params.modelId),
            })
          );
        }
      } else {
        chatId = await this.qwenClient.createChat(params.modelId);
        this.sessionManager.createSession(params.conversationId, chatId, params.modelId);
        qwenMessages.push(...this.buildQwenMessages(params));
      }
    } else {
      chatId = await this.qwenClient.createChat(params.modelId);
      qwenMessages.push(...this.buildQwenMessages(params));
    }

    // Determine thinking settings
    const thinkingEnabled = supportsThinking(params.modelId);
    const thinkingBudget = getDefaultThinkingBudget(params.modelId);

    try {
      // Send streaming request but consume it fully
      const response = await this.qwenClient.streamCompletion(
        chatId,
        params.modelId,
        qwenMessages,
        { thinkingEnabled, thinkingBudget, parentId }
      );

      if (!response.body) {
        throw createProxyError('No response body from Qwen', 500, 'STREAM_ERROR');
      }

      // Create a per-request stream adapter to avoid shared state between concurrent requests
      const streamAdapter = new StreamAdapter();

      // Consume the stream to get the full response
      const fullContent = await streamAdapter.consumeStream(response.body);

      // Also try to get the final chat content for usage info and parent_id extraction
      let usageData = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let reasoningContent: string | undefined;

      try {
        const chatData = await this.qwenClient.getChatContent(chatId);
        const messages = chatData?.data?.chat?.messages || [];
        const assistantMsg = messages.find((m: any) => m.role === 'assistant');
        if (assistantMsg) {
          const contentList = assistantMsg.content_list || [];
          if (contentList.length > 0 && contentList[0].usage) {
            usageData = {
              prompt_tokens: contentList[0].usage.input_tokens || 0,
              completion_tokens: contentList[0].usage.output_tokens || 0,
              total_tokens: contentList[0].usage.total_tokens || 0,
            };
          }
          if (assistantMsg.reasoning_content) {
            reasoningContent = assistantMsg.reasoning_content;
          }
          // Extract fid for next turn's parent_id
          if (params.conversationId && assistantMsg.fid) {
            this.sessionManager.updateLastParentId(params.conversationId, assistantMsg.fid);
          }
        }
      } catch (err) {
        logger.warn('Failed to fetch chat content for usage data', {
          error: (err as Error).message,
        });
      }

      // Check for tool calls in the response
      const toolCalls = this.toolTranslator.extractToolCalls(fullContent);

      // Build OpenAI-compatible response
      const openaiResponse: any = {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: params.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: this.toolTranslator.stripToolCallMarkup(fullContent),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage: usageData,
      };

      res.json(openaiResponse);
    } catch (err) {
      logger.error('Non-streaming completion failed', {
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Normalize messages for Qwen compatibility:
   * - All system messages merged into one at index 0
   * - Empty system messages discarded
   * - Non-system messages preserve original order
   * - Does not mutate the input array
   */
  private normalizeMessages(messages: any[]): any[] {
    const systemParts: string[] = [];
    const rest: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const content =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (content?.trim()) {
          systemParts.push(content.trim());
        }
      } else {
        rest.push(msg);
      }
    }

    return systemParts.length > 0
      ? [{ role: 'system', content: systemParts.join('\n\n') }, ...rest]
      : rest;
  }

  /**
   * Build Qwen messages from OpenAI messages array
   * Qwen constraints: at most 1 system message, must be index 0
   */
  private buildQwenMessages(params: CompletionParams): QwenMessage[] {
    const normalized = this.normalizeMessages(params.messages);
    const qwenMessages: QwenMessage[] = [];

    for (const msg of normalized) {
      if (msg.role === 'system') {
        qwenMessages.push(
          this.qwenClient.buildQwenMessage('system', msg.content, params.modelId, {
            thinkingEnabled: supportsThinking(params.modelId),
            thinkingBudget: getDefaultThinkingBudget(params.modelId),
          })
        );
      } else if (msg.role === 'user') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : this.serializeMultiContent(msg.content);
        qwenMessages.push(
          this.qwenClient.buildQwenMessage('user', content, params.modelId, {
            thinkingEnabled: supportsThinking(params.modelId),
            thinkingBudget: getDefaultThinkingBudget(params.modelId),
          })
        );
      } else if (msg.role === 'assistant') {
        qwenMessages.push(
          this.qwenClient.buildQwenMessage('assistant', msg.content || '', params.modelId)
        );
      } else if (msg.role === 'tool') {
        const toolContent = `Tool result (${msg.name || 'unknown'}): ${msg.content}`;
        qwenMessages.push(
          this.qwenClient.buildQwenMessage('user', toolContent, params.modelId)
        );
      }
    }

    return qwenMessages;
  }

  /**
   * Serialize multi-content (image_url + text) to string
   */
  private serializeMultiContent(content: any[]): string {
    if (!Array.isArray(content)) return String(content);

    return content
      .map((part) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'image_url') return '[Image provided]';
        return JSON.stringify(part);
      })
      .join('\n');
  }

  /**
   * Translate a Qwen SSE chunk to OpenAI format
   */
  private translateStreamChunk(
    chunk: { type: string; data?: any; content?: string; reasoning?: string },
    completionId: string,
    model: string,
    requestId: string
  ): any[] {
    const results: any[] = [];
    const created = Math.floor(Date.now() / 1000);

    // Handle content chunks
    if (chunk.content) {
      const delta: any = {
        role: 'assistant',
        content: chunk.content,
      };

      results.push({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: null,
          },
        ],
      });
    }

    // Handle reasoning/thinking chunks
    if (chunk.reasoning) {
      const delta: any = {
        role: 'assistant',
        content: '',
        reasoning_content: chunk.reasoning,
      };

      results.push({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: null,
          },
        ],
      });
    }

    return results;
  }

  /**
   * Create an OpenAI-format tool call chunk
   */
  private createToolCallChunk(
    toolCalls: any[],
    completionId: string,
    model: string
  ): any {
    return {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map((tc, idx) => ({
              index: idx,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
              },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
  }
}
