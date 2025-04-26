/**
 * Prunes message history to stay under a target percentage of the model's context window.
 * Prioritizes keeping the system prompt (if any), the most recent messages,
 * and handles image filtering.
 * @param {Array} messages - Complete message history (should be cleaned format)
 * @param {string} modelId - The ID of the selected model (for logging).
 * @param {object} modelsForPlatform - Object containing model info for the current platform, keyed by model ID.
 * @returns {Array} - Pruned message history array
 */
function pruneMessageHistory(messages, modelId, modelsForPlatform) {
  // Handle edge cases: empty array or only one message
  if (!messages || !Array.isArray(messages) || messages.length <= 1) {
    return messages ? [...messages] : [];
  }

  // Determine context window size and target token count
  const modelInfo = modelsForPlatform[modelId] || { context: 8192, vision_supported: false }; // Use model data or default
  const effectiveContextWindow = modelInfo.context > 0 ? modelInfo.context : 8192;
  // Use a higher percentage of the context window, e.g., 80%
  const TARGET_CONTEXT_PERCENTAGE = 0.80;
  const targetTokenCount = Math.floor(effectiveContextWindow * TARGET_CONTEXT_PERCENTAGE);

  console.log(`Pruning for model ${modelId}. Context: ${effectiveContextWindow}, Target Tokens: ${targetTokenCount} (${TARGET_CONTEXT_PERCENTAGE * 100}%)`);

  // Create a copy to avoid modifying the original array
  let prunedMessages = [...messages];

  // --- Image Pruning Logic (Keep as is for now) --- //
  let totalImageCount = 0;
  let lastUserMessageWithImagesIndex = -1;
  prunedMessages.forEach((msg, index) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageParts = msg.content.filter(part => part.type === 'image_url');
      if (imageParts.length > 0) {
        totalImageCount += imageParts.length;
        lastUserMessageWithImagesIndex = index;
      }
    }
  });
  if (totalImageCount > 5 && lastUserMessageWithImagesIndex !== -1) {
    console.log(`Total image count (${totalImageCount}) exceeds 5. Keeping images only from the last user message (index ${lastUserMessageWithImagesIndex}).`);
    prunedMessages = prunedMessages.map((msg, index) => {
      if (msg.role === 'user' && Array.isArray(msg.content) && index !== lastUserMessageWithImagesIndex) {
        const textParts = msg.content.filter(part => part.type === 'text');
        if (textParts.length > 0) {
           return { ...msg, content: textParts };
        } else {
           return { ...msg, content: [{ type: 'text', text: '' }] };
        }
      }
      return msg;
    });
  }
  // --- End Image Pruning Logic --- //

  // Recalculate tokens after potential image pruning
  let currentTotalTokens = prunedMessages.reduce((sum, msg) => sum + estimateTokenCount(msg), 0);

  // If we're already under the target, no text-based pruning needed
  if (currentTotalTokens <= targetTokenCount) {
    console.log(`Token count (${currentTotalTokens}) is within target (${targetTokenCount}). No text pruning needed.`);
    return prunedMessages;
  }

  console.log(`Token count (${currentTotalTokens}) exceeds target (${targetTokenCount}). Starting text pruning...`);

  // --- Smarter Text Pruning Logic --- //
  let messagesPrunedCount = 0;

  // Always keep the first message (index 0), usually system prompt or first user message.
  const systemMessage = prunedMessages.length > 0 ? prunedMessages[0] : null;
  // Temporarily remove the system message to simplify pruning loop
  if (systemMessage) {
      prunedMessages.shift();
      currentTotalTokens -= estimateTokenCount(systemMessage);
  }

  // Prune from the oldest messages (now index 0) upwards, always keeping the last one
  while (prunedMessages.length > 1 && currentTotalTokens > targetTokenCount) {
      // Estimate token count of the message to remove (oldest one)
      const messageToRemove = prunedMessages[0];
      const tokensForMessage = estimateTokenCount(messageToRemove);

      // Remove the oldest message
      prunedMessages.shift();
      currentTotalTokens -= tokensForMessage;
      messagesPrunedCount++;
      // console.log(`Pruned oldest message (was role ${messageToRemove.role}). New count: ${prunedMessages.length}, Tokens: ${currentTotalTokens}`);
  }

  // Add the system message back to the beginning
  if (systemMessage) {
      prunedMessages.unshift(systemMessage);
      // No need to add system message tokens back to currentTotalTokens, as it's just for comparison
  }
  // --- End Smarter Text Pruning Logic --- //

  // Final check and logging
  const finalTokenCount = prunedMessages.reduce((sum, msg) => sum + estimateTokenCount(msg), 0);
  if (messagesPrunedCount > 0) {
    console.log(`Pruned ${messagesPrunedCount} messages based on token count. Final tokens: ${finalTokenCount} (target: ${targetTokenCount})`);
  }
  if(finalTokenCount > targetTokenCount) {
      console.warn(`Final token count (${finalTokenCount}) still exceeds target (${targetTokenCount}) after pruning. The last message might be too large.`);
      // Potentially truncate the last message content if absolutely necessary?
      // For now, just warn.
  }


  return prunedMessages;
}

/**
 * Estimates token count for a single message (ignoring image tokens).
 * @param {Object} message - Message object with role and content.
 * @returns {Number} - Estimated token count.
 */
function estimateTokenCount(message) {
  if (!message) return 0;

  let tokenCount = 0;
  let textContent = '';

  // Handle different content structures (string or array)
  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    // Sum text content length from text parts
    textContent = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n'); // Join text parts for length calculation
  }
  // NOTE: Ignoring non-text/image parts if the array format is extended.

  // Basic approximation: characters / 4
  if (textContent) {
    // Add tokens based on character count (e.g., simple approximation)
    tokenCount += Math.ceil(textContent.length / 4);
  }

  // Account for tool calls in assistant messages
  if (message.role === 'assistant' && message.tool_calls && Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach(toolCall => {
      // Estimate tokens for the JSON representation of the tool call
      try {
          const serializedToolCall = JSON.stringify(toolCall);
          tokenCount += Math.ceil(serializedToolCall.length / 4);
      } catch (e) {
          console.warn("Error serializing tool call for token estimation:", e);
          tokenCount += 50; // Add arbitrary penalty if serialization fails
      }
    });
  }

  // Account for tool results in tool messages
  if (message.role === 'tool') {
      // Estimate tokens for the (potentially stringified) content of the tool result
      const contentString = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      tokenCount += Math.ceil(contentString.length / 4);
      // Add a small overhead for the tool role/id itself
      tokenCount += 10; // Rough estimate for tool_call_id, role etc.
  }

  // Add a small base token count per message for metadata (role, etc.)
  tokenCount += 5; // Arbitrary small number

  // NOTE: Image token cost is currently ignored in this estimation.
  // A more accurate approach would require model-specific tokenization or heuristics.

  return tokenCount;
}

module.exports = {
    pruneMessageHistory,
    estimateTokenCount
}; 