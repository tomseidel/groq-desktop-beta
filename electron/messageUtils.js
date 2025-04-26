const { get_encoding, encoding_for_model } = require("@dqbd/tiktoken");

// Using cl100k_base as a general default suitable for gpt-4, gpt-3.5-turbo, text-embedding-ada-002, etc.
// More specific model-to-encoding mapping can be added if needed.
const defaultEncoding = get_encoding("cl100k_base");

/**
 * Estimates the number of tokens for a given text using tiktoken.
 * @param {string} text The text to encode.
 * @returns {number} The estimated number of tokens.
 */
function countTokens(text) {
  if (!text) return 0;
  try {
    return defaultEncoding.encode(text).length;
  } catch (error) {
    console.warn("Tiktoken encoding failed, falling back to rough estimate:", error);
    // Fallback to rough character count if encoding fails
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimates the total tokens for an array of message objects.
 * Follows the format suggested by OpenAI for token counting.
 * Reference: https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
 * @param {Array<object>} messages Array of message objects.
 * @param {string} modelId (Optional) Model ID to potentially use specific encoding. Currently uses default.
 * @returns {number} Total estimated tokens.
 */
function countTokensForMessages(messages, modelId = 'gpt-4') { // modelId currently unused, using default encoder
    let num_tokens = 0;
    messages.forEach(message => {
        num_tokens += 4; // every message follows <im_start>{role/name}\n{content}<im_end>\n
        Object.entries(message).forEach(([key, value]) => {
            if (key === 'content') {
                if (typeof value === 'string') {
                    num_tokens += countTokens(value);
                } else if (Array.isArray(value)) {
                    // Handle array content (text and image_url)
                    value.forEach(part => {
                        if (part.type === 'text') {
                             num_tokens += countTokens(part.text);
                        } else if (part.type === 'image_url') {
                            // Token cost for images is complex and varies.
                            // OpenAI uses a fixed cost + cost based on resolution for GPT-4V.
                            // Let's use a placeholder fixed cost for simplicity, can be refined.
                            // See: https://openai.com/pricing (Vision section) - e.g., 85 tokens for low-res, more for high-res.
                            num_tokens += 85; // Placeholder for a low-res image tile
                        }
                    });
                }
            } else if (key === 'tool_calls' && Array.isArray(value)) {
                 // Count tokens for tool calls (function name + arguments)
                 value.forEach(toolCall => {
                    if (toolCall.function) {
                        num_tokens += countTokens(toolCall.function.name || '');
                        num_tokens += countTokens(toolCall.function.arguments || '');
                    }
                 });
            } else if (key === 'name') { // if there's a name, the role is omitted
                num_tokens -= 1; // role is always required and always 1 token
                num_tokens += countTokens(value);
            } else if (key !== 'role'){ // Skip role as it's implicitly counted in the 4 per message
                // Count other potential string values (like tool_call_id)
                if (typeof value === 'string') {
                     num_tokens += countTokens(value);
                }
            }
        });
    });
    num_tokens += 2; // every reply is primed with <im_start>assistant
    return num_tokens;
}


/**
 * Ensures the message history fits within the model's context window by truncating older messages.
 * Keeps the system prompt if present.
 * @param {Array<object>} messages The original message array.
 * @param {number} contextLimit The maximum allowed tokens for the model.
 * @param {string} modelId (Optional) Model ID for token counting.
 * @param {number} safetyBuffer A buffer subtracted from the context limit (e.g., 200 tokens).
 * @returns {Array<object>} The potentially truncated message array.
 */
function ensureContextFits(messages, contextLimit, modelId = 'gpt-4', safetyBuffer = 200) {
    const maxTokens = contextLimit - safetyBuffer;
    let currentMessages = [...messages];
    
    // Separate system prompt if it exists
    let systemPrompt = null;
    if (currentMessages.length > 0 && currentMessages[0].role === 'system') {
        systemPrompt = currentMessages.shift(); // Remove system prompt temporarily
    }

    // Remove oldest messages until context fits
    while (currentMessages.length > 0) {
        const messagesToCheck = systemPrompt ? [systemPrompt, ...currentMessages] : currentMessages;
        const currentTokens = countTokensForMessages(messagesToCheck, modelId);
        
        if (currentTokens <= maxTokens) {
            break; // Fits within the limit
        }

        console.warn(`Context window exceeded (${currentTokens} > ${maxTokens}). Truncating oldest message.`);
        currentMessages.shift(); // Remove the oldest message (first in the array after potential system prompt)
    }
    
    // Add system prompt back if it existed
    if (systemPrompt) {
        currentMessages.unshift(systemPrompt);
    }

    if (messages.length > currentMessages.length) {
         console.log(`Truncated ${messages.length - currentMessages.length} messages to fit context limit.`);
    }

    return currentMessages;
}

// --- Deprecate or update pruneMessageHistory ---
// Keep the old one for now, but ideally replace its usage with ensureContextFits
/**
 * Prunes message history based on estimated token count using a simple heuristic.
 * DEPRECATED: Use ensureContextFits with tiktoken for better accuracy.
 * @param {Array<object>} messages - Array of message objects.
 * @param {string} modelId - The ID of the model being used.
 * @param {object} modelDefinitions - Object containing model context sizes.
 * @returns {Array<object>} The pruned array of messages.
 */
 function pruneMessageHistory(messages, modelId, modelDefinitions = {}) {
    console.warn("DEPRECATED: pruneMessageHistory called. Use ensureContextFits instead.");
    const modelInfo = modelDefinitions[modelId] || modelDefinitions['default'] || { context: 8192 };
    const maxTokens = modelInfo.context;
    const buffer = 500; // Keep a buffer for response generation and system prompt
    let currentTokenEstimate = 0;
    const pruned = [];

    // Very rough estimate: average chars per token (adjust as needed)
    const charsPerToken = 4;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        let messageTokens = 0;
        // Estimate tokens for the message content (string or array)
        if (typeof msg.content === 'string') {
            messageTokens += Math.ceil(msg.content.length / charsPerToken);
        } else if (Array.isArray(msg.content)) {
            msg.content.forEach(part => {
                 if (part.type === 'text') {
                    messageTokens += Math.ceil((part.text || '').length / charsPerToken);
                 } else if (part.type === 'image_url') {
                     // Very rough fixed estimate for image
                     messageTokens += 100; 
      }
    });
  }
        // Add some overhead for role, etc.
        messageTokens += 10; 

        if (currentTokenEstimate + messageTokens <= maxTokens - buffer) {
            pruned.unshift(msg); // Add message to the beginning of the pruned list
            currentTokenEstimate += messageTokens;
        } else {
            // Stop adding messages once the limit is reached
            console.log(`Pruning history: Estimated ${currentTokenEstimate} tokens. Max: ${maxTokens - buffer}. Stopping at index ${i}.`);
            break;
        }
    }
    return pruned;
}


module.exports = {
    countTokens,
    countTokensForMessages,
    ensureContextFits,
    pruneMessageHistory // Keep exporting old one for now
};
