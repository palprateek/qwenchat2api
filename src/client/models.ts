/**
 * Model mapping and resolution for Qwen models
 */

export interface ModelInfo {
  id: string;
  info: string;
  capabilities: Record<string, any>;
}

/**
 * Mapping of friendly model names to chat.qwen.ai model IDs
 */
export const QWEN_MODEL_MAP: Record<string, string> = {
  // Friendly aliases → upstream model IDs
  'qwen': 'qwen-max-latest',
  'qwen-max': 'qwen-max-latest',
  'qwen-think': 'qwen3-235b-a22b',
  'qwen-coder': 'qwen3-coder-plus',
  'qwen-flash': 'qwen3-30b-a3b',
  'qwen-vl': 'qwen3-vl-plus',
  'qwq': 'qwq-32b',
};

/**
 * Models that support thinking/reasoning mode
 */
export const THINKING_MODELS = new Set([
  'qwen3-235b-a22b',
  'qwen3-max-preview',
  'qwen3-30b-a3b',
  'qwq-32b',
  'qwen-max-latest',
  'qwen3-coder-plus',
]);

/**
 * Models that support vision/image input
 */
export const VISION_MODELS = new Set([
  'qwen3-vl-plus',
  'qvq-72b-preview-0310',
  'qwen2.5-omni-7b',
  'qwen2.5-vl-32b-instruct',
]);

/**
 * Resolve a requested model name to the actual chat.qwen.ai model ID
 */
export function resolveModel(
  requestedModel: string,
  availableModels?: Map<string, ModelInfo>
): string {
  // 1. Check friendly name mapping
  const mapped = QWEN_MODEL_MAP[requestedModel];
  if (mapped) {
    // Verify mapped model exists in available models (if we have them)
    if (availableModels && availableModels.has(mapped)) {
      return mapped;
    }
    // Even if not in available models, use the mapping (API might have new models)
    return mapped;
  }

  // 2. Check if the requested name is already a valid model ID
  if (availableModels && availableModels.has(requestedModel)) {
    return requestedModel;
  }

  // 3. Return the requested model as-is if it looks like a real model ID
  if (requestedModel.startsWith('qwen') || requestedModel.startsWith('qwq')) {
    return requestedModel;
  }

  // 4. Default fallback
  return 'qwen-max-latest';
}

/**
 * Check if a model supports thinking/reasoning
 */
export function supportsThinking(modelId: string): boolean {
  return THINKING_MODELS.has(modelId);
}

/**
 * Check if a model supports vision/image input
 */
export function supportsVision(modelId: string): boolean {
  return VISION_MODELS.has(modelId);
}

/**
 * Get default thinking budget for a model
 */
export function getDefaultThinkingBudget(modelId: string): number {
  if (THINKING_MODELS.has(modelId)) {
    return 8192;
  }
  return 0;
}
