/**
 * Tool Call Translator
 *
 * Converts between OpenAI native tool_calls format and
 * Qwen's XML-style tool call format.
 *
 * Qwen models emit tool calls as XML-style markup like:
 *   ✿{"name": "read_file", "arguments": {"path": "x"}}✿
 *   or
 *   <tool_call name="read_file">{"path": "x"}</tool_call
 *
 * This module:
 * 1. Injects tool definitions into the system prompt (prompt engineering)
 * 2. Extracts tool calls from Qwen's XML/text output
 * 3. Converts them to OpenAI tool_calls format
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';

const logger = createLogger('tool-translator');

/**
 * Pattern 1: ✿...✿ delimiters (used by qwen-api reference)
 */
const FLOWER_DELIM_PATTERN = /✿\s*(\{[\s\S]*?\})\s*✿/g;

/**
 * Pattern 2: <tool_call name="...">...</tool_call
 */
const XML_TOOL_CALL_PATTERN = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/g;

/**
 * Pattern 3: ◰...◰ delimiters (alternative format)
 */
const TRIANGLE_DELIM_PATTERN = /◰\s*(\{[\s\S]*?\})\s*◰/g;

/**
 * Pattern 4: Simple JSON blocks preceded by "Action:" or "Function Call:"
 */
const ACTION_PATTERN = /(?:Action|Function Call|Tool Call):\s*\n?\s*(\{[\s\S]*?\})\n/g;

/**
 * OpenAI tool_calls format
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export class ToolCallTranslator {
  /**
   * Inject tool definitions into messages as a system prompt addition
   *
   * Since Qwen doesn't natively support OpenAI-style tool definitions,
   * we use prompt engineering to describe available tools.
   */
  injectToolDefinitions(messages: any[], tools?: any[]): any[] {
    if (!tools || tools.length === 0) return messages;

    const toolDescriptions = this.formatToolDefinitions(tools);

    // Find or create system message
    const systemIdx = messages.findIndex((m) => m.role === 'system');

    if (systemIdx >= 0) {
      // Append tool definitions to existing system message
      const updated = [...messages];
      updated[systemIdx] = {
        ...updated[systemIdx],
        content: updated[systemIdx].content + '\n\n' + toolDescriptions,
      };
      return updated;
    } else {
      // Insert system message with tool definitions at the beginning
      return [
        { role: 'system', content: toolDescriptions },
        ...messages,
      ];
    }
  }

  /**
   * Format tool definitions as a system prompt section
   */
  private formatToolDefinitions(tools: any[]): string {
    const toolDefs = tools
      .map((tool) => {
        if (tool.type === 'function' && tool.function) {
          const fn = tool.function;
          return JSON.stringify({
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          });
        }
        return null;
      })
      .filter(Boolean);

    return `# Tools

You may call one or more functions to assist with the user query.
You are provided with function signatures within <tools></tools> XML tags:

<tools>
${toolDefs.join('\n')}
</tools>

For each function call, return a json object with function name and arguments within ✿✿ XML tags:
✿
{"name": <function-name>, "arguments": <args-json-object>}
✿

IMPORTANT: When you need to call a tool, output the tool call in the exact format above. Do NOT output any other text when making a tool call.`;
  }

  /**
   * Extract tool calls from Qwen's text output
   */
  extractToolCalls(content: string): OpenAIToolCall[] {
    const toolCalls: OpenAIToolCall[] = [];

    // Try all known patterns
    const allMatches: { name: string; arguments: any }[] = [];

    // Pattern 1: ✿...✿ delimiters
    let match: RegExpExecArray | null;
    FLOWER_DELIM_PATTERN.lastIndex = 0;
    while ((match = FLOWER_DELIM_PATTERN.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name) {
          allMatches.push({
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || {},
          });
        }
      } catch {
        logger.debug('Failed to parse ✿...✿ tool call', { match: match[1]?.slice(0, 100) });
      }
    }

    // Pattern 2: <tool_call name="...">...</tool_call
    XML_TOOL_CALL_PATTERN.lastIndex = 0;
    while ((match = XML_TOOL_CALL_PATTERN.exec(content)) !== null) {
      try {
        const args = JSON.parse(match[2]);
        allMatches.push({ name: match[1], arguments: args });
      } catch {
        // Try as raw arguments string
        allMatches.push({ name: match[1], arguments: match[2].trim() });
      }
    }

    // Pattern 3: ◰...◰ delimiters
    TRIANGLE_DELIM_PATTERN.lastIndex = 0;
    while ((match = TRIANGLE_DELIM_PATTERN.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name) {
          allMatches.push({
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || {},
          });
        }
      } catch {
        logger.debug('Failed to parse ◰...◰ tool call');
      }
    }

    // Pattern 4: Action/Function Call blocks
    ACTION_PATTERN.lastIndex = 0;
    while ((match = ACTION_PATTERN.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name) {
          allMatches.push({
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || {},
          });
        }
      } catch {
        logger.debug('Failed to parse Action: tool call');
      }
    }

    // Convert matches to OpenAI format
    for (const m of allMatches) {
      toolCalls.push({
        id: `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: m.name,
          arguments:
            typeof m.arguments === 'string' ? m.arguments : JSON.stringify(m.arguments),
        },
      });
    }

    if (toolCalls.length > 0) {
      logger.info(`Extracted ${toolCalls.length} tool call(s) from response`, {
        tools: toolCalls.map((tc) => tc.function.name),
      });
    }

    return toolCalls;
  }

  /**
   * Strip tool call markup from content text
   * Returns the clean text without tool call markers
   */
  stripToolCallMarkup(content: string): string {
    let cleaned = content;

    // Remove ✿...✿ blocks
    cleaned = cleaned.replace(/✿\s*\{[\s\S]*?\}\s*✿/g, '');

    // Remove <tool_call ...>...</tool_call blocks
    cleaned = cleaned.replace(/<tool_call\s+name=["'][^"']+["']\s*>[\s\S]*?<\/tool_call>/g, '');

    // Remove ◰...◰ blocks
    cleaned = cleaned.replace(/◰\s*\{[\s\S]*?\}\s*◰/g, '');

    // Remove Action:/Function Call: blocks
    cleaned = cleaned.replace(
      /(?:Action|Function Call|Tool Call):\s*\n?\s*\{[\s\S]*?\}\n/g,
      ''
    );

    // Clean up whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }
}
