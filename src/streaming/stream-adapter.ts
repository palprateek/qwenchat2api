/**
 * SSE Stream Adapter
 *
 * Processes Server-Sent Events from chat.qwen.ai and
 * converts them into a normalized format for the
 * OpenAI compatibility layer.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('stream');

interface ParsedChunk {
  type: 'content' | 'reasoning' | 'done' | 'error' | 'metadata';
  content?: string;
  reasoning?: string;
  data?: any;
}

export class StreamAdapter {
  private accumulatedContent: string = '';
  private accumulatedReasoning: string = '';
  private completed: boolean = false;

  /**
   * Process a Qwen SSE stream, calling handlers for each parsed chunk
   */
  async processStream(
    body: NodeJS.ReadableStream,
    onChunk: (chunk: ParsedChunk) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    this.accumulatedContent = '';
    this.accumulatedReasoning = '';
    this.completed = false;

    return new Promise<void>((resolve, reject) => {
      let buffer = '';

      const safeComplete = () => {
        if (this.completed) return;
        this.completed = true;
        try {
          onComplete();
        } catch (err) {
          onError(err as Error);
        }
        resolve();
      };

      body.on('data', (data: Buffer) => {
        buffer += data.toString('utf-8');

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (this.completed) return;
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip comments and empty lines

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();

            if (dataStr === '[DONE]') {
              safeComplete();
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const chunks = this.parseQwenSSEData(parsed);

              for (const chunk of chunks) {
                if (chunk.type === 'content' && chunk.content) {
                  this.accumulatedContent += chunk.content;
                }
                if (chunk.type === 'reasoning' && chunk.reasoning) {
                  this.accumulatedReasoning += chunk.reasoning;
                }
                onChunk(chunk);
              }
            } catch (parseErr) {
              logger.debug('Failed to parse SSE data', {
                data: dataStr.slice(0, 200),
                error: (parseErr as Error).message,
              });
            }
          }
        }
      });

      body.on('end', () => {
        // Process any remaining buffer
        if (buffer.trim() && !this.completed) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(dataStr);
                const chunks = this.parseQwenSSEData(parsed);
                for (const chunk of chunks) {
                  if (chunk.type === 'content' && chunk.content) {
                    this.accumulatedContent += chunk.content;
                  }
                  if (chunk.type === 'reasoning' && chunk.reasoning) {
                    this.accumulatedReasoning += chunk.reasoning;
                  }
                  onChunk(chunk);
                }
              } catch {
                // Ignore parse errors on final buffer
              }
            }
          }
        }

        safeComplete();
      });

      body.on('error', (err) => {
        logger.error('Stream read error', { error: err.message });
        this.completed = true;
        onError(err);
        reject(err);
      });
    });
  }

  /**
   * Consume a stream and return the full accumulated content
   * Used for non-streaming mode
   */
  async consumeStream(body: NodeJS.ReadableStream): Promise<string> {
    this.accumulatedContent = '';
    this.accumulatedReasoning = '';

    return new Promise((resolve, reject) => {
      let buffer = '';

      body.on('data', (data: Buffer) => {
        buffer += data.toString('utf-8');

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              const chunks = this.parseQwenSSEData(parsed);
              for (const chunk of chunks) {
                if (chunk.type === 'content' && chunk.content) {
                  this.accumulatedContent += chunk.content;
                }
                if (chunk.type === 'reasoning' && chunk.reasoning) {
                  this.accumulatedReasoning += chunk.reasoning;
                }
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      });

      body.on('end', () => {
        resolve(this.accumulatedContent);
      });

      body.on('error', (err) => {
        logger.error('Stream consume error', { error: err.message });
        // If we have partial content, return it rather than losing the response entirely.
        // But if nothing was accumulated, reject so the caller knows the request failed.
        if (this.accumulatedContent.length > 0) {
          logger.warn('Returning partial content after stream error', {
            contentLength: this.accumulatedContent.length,
          });
          resolve(this.accumulatedContent);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Get the content accumulated from the stream
   */
  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  /**
   * Get the reasoning content accumulated from the stream
   */
  getAccumulatedReasoning(): string {
    return this.accumulatedReasoning;
  }

  /**
   * Parse Qwen SSE data into normalized chunks
   *
   * The Qwen SSE format can vary between API versions.
   * This handles multiple known formats:
   *
   * Format 1 (v2 completions):
   * { choices: [{ delta: { content: "..." }, finish_reason: null }] }
   *
   * Format 2 (v2 with reasoning):
   * { choices: [{ delta: { content: "..." , reasoning_content: "..." } }] }
   *
   * Format 3 (older format):
   * { choices: [{ message: { content: "..." } }] }
   */
  private parseQwenSSEData(data: any): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];

    // Handle choices array
    if (data?.choices && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        const delta = choice.delta || choice.message;
        if (!delta) continue;

        // Regular content
        if (delta.content) {
          chunks.push({
            type: 'content',
            content: delta.content,
          });
        }

        // Reasoning/thinking content
        if (delta.reasoning_content) {
          chunks.push({
            type: 'reasoning',
            reasoning: delta.reasoning_content,
          });
        }

        // Finish reason
        if (choice.finish_reason) {
          chunks.push({
            type: 'metadata',
            data: { finish_reason: choice.finish_reason },
          });
        }
      }
    }

    // Handle usage data (may come in final chunk)
    if (data?.usage) {
      chunks.push({
        type: 'metadata',
        data: { usage: data.usage },
      });
    }

    // Handle web search info
    if (data?.choices?.[0]?.delta?.extra?.web_search_info) {
      chunks.push({
        type: 'metadata',
        data: { web_search_info: data.choices[0].delta.extra.web_search_info },
      });
    }

    // If no structured data found, try treating entire object as content
    if (chunks.length === 0 && typeof data === 'object' && data !== null) {
      // Some Qwen responses embed content differently
      const content = data.content || data.text || data.output?.text;
      if (content) {
        chunks.push({ type: 'content', content });
      } else {
        // Log unrecognized SSE data format for debugging
        logger.warn('Unrecognized SSE data format', {
          keys: Object.keys(data),
          sample: JSON.stringify(data).slice(0, 300),
        });
      }
    }

    return chunks;
  }
}
