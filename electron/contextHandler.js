const { get_encoding } = require("@dqbd/tiktoken");
const https = require('https'); // Add HTTPS module for summarization API call

// Using cl100k_base as a general default suitable for gpt-4, gpt-3.5-turbo, text-embedding-ada-002, etc.
const defaultEncoding = get_encoding("cl100k_base");
const SUMMARIZATION_MODEL = "google/gemini-2.0-flash-exp:free"; // Updated model name based on latest free tier availability
const SUMMARIZATION_MAX_TOKENS = 1000; // Max tokens for the summary itself

/**
 * Estimates the number of tokens for a given text using tiktoken.
 */
function countTokens(text) {
  if (!text) return 0;
  try {
    return defaultEncoding.encode(text).length;
  } catch (error) {
    console.warn("Tiktoken encoding failed, falling back to rough estimate:", error);
    // Basic fallback: average character count per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimates the total tokens for an array of message objects, updated for tool calls.
 * (Identical to the version previously in chatHandler.js)
 */
function countTokensForMessages(messages) {
    let num_tokens = 0;
    messages.forEach(message => {
        // Base cost per message
        num_tokens += 4;

        Object.entries(message).forEach(([key, value]) => {
            // Count tokens for common string values like role, name, tool_call_id
            if (typeof value === 'string') {
                num_tokens += countTokens(value);
            }

            // Specific handling for content
            if (key === 'content') {
                if (typeof value === 'string') {
                    // Already counted above if string
                } else if (Array.isArray(value)) { // User message content parts
                    value.forEach(part => {
                        if (part.type === 'text') {
                             num_tokens += countTokens(part.text || '');
                        } else if (part.type === 'image_url') {
                            // Placeholder cost for images (simple estimate)
                            num_tokens += 85;
                        }
                        // Ignore file_content/file_error here as they were converted to text parts earlier
                    });
                } // Null content (assistant message with only tool calls) contributes 0 tokens
            }
            // Specific handling for assistant tool calls
            else if (key === 'tool_calls' && message.role === 'assistant' && Array.isArray(value)) {
                 value.forEach(toolCall => {
                    if (toolCall.function) {
                        // Count function name and arguments (already counted if string via loop above, need name explicitly)
                        num_tokens += countTokens(toolCall.function.name || '');
                        num_tokens += countTokens(toolCall.function.arguments || '');
                    }
                 });
            }
        });

        // Adjust for name/tool_call_id overhead (-1 token adjustment)
        if (message.name || message.tool_call_id) {
            num_tokens -= 1; // If name or tool_call_id is present, it replaces role, save 1 token
        }
    });
    num_tokens += 2; // Every reply is primed with <|im_start|>assistant
    return num_tokens;
}

/**
 * Calls the summarization API (OpenRouter) to condense messages.
 * @param {Array<object>} messagesToSummarize - The array of message objects to summarize.
 * @param {string} openrouterApiKey - The API key for OpenRouter.
 * @returns {Promise<string | null>} The summary text or null if failed.
 */
async function summarizeMessages(messagesToSummarize, openrouterApiKey) {
    console.log(`[summarizeMessages] Attempting to summarize ${messagesToSummarize.length} messages.`);
    if (messagesToSummarize.length === 0) {
        console.warn("[summarizeMessages] No messages provided for summarization.");
        return null;
    }
    if (!openrouterApiKey) {
         console.error("[summarizeMessages] OpenRouter API key is missing.");
         return null;
    }

    // Simple text representation for summarization prompt
    const historyText = messagesToSummarize.map(msg => {
        let contentText = "";
        if (typeof msg.content === 'string') {
            contentText = msg.content;
        } else if (Array.isArray(msg.content)) {
            contentText = msg.content.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join(' ');
        } else if (msg.tool_calls) {
            contentText = msg.tool_calls.map(tc => `[Requesting tool: ${tc.function?.name}]`).join(' ');
        } else if (msg.role === 'tool') {
            contentText = `[Tool result for ${msg.name}: ${msg.content}]`;
        }
        return `${msg.role}: ${contentText}`;
    }).join('\n\n');

    const systemPrompt = `You are an expert conversation summarizer. Condense the following chat history, focusing ONLY on the most critical information, key decisions, user goals, facts, and crucial context needed to understand subsequent messages. Explicitly retain any stated user instructions or preferences for how the assistant should behave.

When summarizing tool interactions (indicated by '[Requesting tool: ...]' and '[Tool result for ...:]'), capture the essential information: what tool was called, for what purpose (if clear from surrounding messages), and the key outcome or data from the result. Avoid excessive detail about arguments or raw output unless absolutely critical.

Be extremely concise and use neutral language. Maximum summary length: ${SUMMARIZATION_MAX_TOKENS} tokens. Start the summary directly without preamble.`;

    const apiRequestBody = {
        model: SUMMARIZATION_MODEL,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Summarize this conversation history:\n\n---\n${historyText}\n---` }
        ],
        max_tokens: SUMMARIZATION_MAX_TOKENS,
        temperature: 0.3, // Low temperature for factual summary
    };

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openrouterApiKey}`,
                // Add referrer/title headers if desired
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const responseJson = JSON.parse(data);
                        const summary = responseJson.choices?.[0]?.message?.content?.trim();
                        if (summary) {
                            console.log(`[summarizeMessages] Successfully generated summary (${countTokens(summary)} tokens).`);
                            resolve(summary);
                        } else {
                            console.error("[summarizeMessages] Failed to extract summary from API response:", data);
                            resolve(null);
                        }
                    } catch (e) {
                        console.error("[summarizeMessages] Error parsing summary response JSON:", e, "Data:", data);
                        resolve(null);
                    }
                } else {
                    console.error(`[summarizeMessages] API request failed with status ${res.statusCode}:`, data);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error("[summarizeMessages] API request error:", e);
            resolve(null);
        });

        req.write(JSON.stringify(apiRequestBody));
        req.end();
    });
}

/**
 * Phase 4 Implementation: Builds an optimized message history for API calls.
 * Incorporates caching, calls summarization function when needed (if enabled via settings).
 *
 * @param {Array<object>} fullHistory - The complete, original message history.
 * @param {object | null} systemPromptMessage - The system prompt message object.
 * @param {number} modelContextLimit - The actual context window limit of the target model.
 * @param {string} modelId - The model ID (used for logging).
 * @param {object | null} cachedSummary - The current cached summary object { text: string, coversMessagesUpToIndex: number }.
 * @param {string} openrouterApiKey - API key needed for summarization.
 * @param {number} targetTokenLimitSetting - The user-configured target token limit.
 * @param {boolean} enableSummarizationSetting - Whether summarization is enabled.
 * @returns {Promise<{history: Array<object>, updatedCache: object | null}>} An object containing the optimized history and the potentially updated cache object.
 */
async function buildOptimizedHistory(fullHistory, systemPromptMessage, modelContextLimit, modelId, cachedSummary, openrouterApiKey, targetTokenLimitSetting, enableSummarizationSetting) {
    const targetTokenLimit = targetTokenLimitSetting || 50000; // Use setting or fallback
    const enableSummarization = enableSummarizationSetting ?? true; // Use setting or fallback

    // Adjust effective limit calculation to account for summary only if summarization is enabled
    const summarySpace = enableSummarization ? SUMMARIZATION_MAX_TOKENS : 0;
    const effectiveLimit = Math.min(targetTokenLimit, modelContextLimit) - summarySpace;
    console.log(`[buildOptimizedHistory P4] Target: ${targetTokenLimit}, Model: ${modelContextLimit}, Summarization Enabled: ${enableSummarization}, Effective Limit (for messages): ${effectiveLimit}`);

    const historyToCheck = systemPromptMessage ? [systemPromptMessage, ...fullHistory] : [...fullHistory];
    const currentTokens = countTokensForMessages(historyToCheck);

    console.log(`[buildOptimizedHistory P4] Current Tokens: ${currentTokens} (vs Target Limit: ${targetTokenLimit})`);

    let finalHistory = [];
    let updatedCache = cachedSummary;

    if (currentTokens <= targetTokenLimit) {
        console.log("[buildOptimizedHistory P4] History fits within target limit. Using full history.");
        finalHistory = systemPromptMessage ? [systemPromptMessage, ...fullHistory] : [...fullHistory];
    } else {
        console.log("[buildOptimizedHistory P4] History exceeds target limit. Applying optimization...");

        // Determine messages to keep (respecting effectiveLimit which includes summary space if needed)
        let tokensForKeptMessages = 0;
        let keepIndex = fullHistory.length;
        const systemPromptTokens = systemPromptMessage ? countTokensForMessages([systemPromptMessage]) : 0;
        // Estimate summary token space only if summarization is enabled
        const summaryPlaceholderTokens = enableSummarization
            ? (cachedSummary ? countTokensForMessages([{ role: "system", content: cachedSummary.text }]) : SUMMARIZATION_MAX_TOKENS * 1.1)
            : 0;

        while (keepIndex > 0) {
            keepIndex--;
            const messageToKeep = fullHistory[keepIndex];
            const messageTokens = countTokensForMessages([messageToKeep]);
            // Check against the overall target limit
            if (tokensForKeptMessages + messageTokens + systemPromptTokens + summaryPlaceholderTokens > targetTokenLimit) {
                keepIndex++;
                break;
            }
            tokensForKeptMessages += messageTokens;
        }

        const messagesToKeep = fullHistory.slice(keepIndex);
        const messagesToSummarizeOrPrune = fullHistory.slice(0, keepIndex);
        console.log(`[buildOptimizedHistory P4] Keeping ${messagesToKeep.length} recent messages (Index ${keepIndex}). Need to summarize/prune ${messagesToSummarizeOrPrune.length}.`);

        // Attempt Summarization only if enabled
        if (enableSummarization) {
            const isCacheValid = cachedSummary && cachedSummary.coversMessagesUpToIndex >= keepIndex;

            if (isCacheValid) {
                console.log(`[buildOptimizedHistory P4] Valid cache found. Using cached summary.`);
                const summaryMessage = { role: "system", content: `[Summary of prior conversation]:\n${cachedSummary.text}` };
                finalHistory = systemPromptMessage
                    ? [systemPromptMessage, summaryMessage, ...messagesToKeep]
                    : [summaryMessage, ...messagesToKeep];
                updatedCache = cachedSummary;
            } else {
                console.log(`[buildOptimizedHistory P4] No valid cache or summarization needed. Attempting summarization.`);
                const messagesForNewSummary = cachedSummary?.text
                    ? [{ role: "system", content: `Previous Summary:\n${cachedSummary.text}` }, ...messagesToSummarizeOrPrune]
                    : messagesToSummarizeOrPrune;

                const newSummaryText = await summarizeMessages(messagesForNewSummary, openrouterApiKey);

                if (newSummaryText) {
                    console.log("[buildOptimizedHistory P4] Summarization successful.");
                    const newCache = { text: newSummaryText, coversMessagesUpToIndex: keepIndex };
                    const summaryMessage = { role: "system", content: `[Summary of prior conversation]:\n${newSummaryText}` };
                    finalHistory = systemPromptMessage
                        ? [systemPromptMessage, summaryMessage, ...messagesToKeep]
                        : [summaryMessage, ...messagesToKeep];
                    updatedCache = newCache;
                } else {
                    console.warn("[buildOptimizedHistory P4] Summarization failed or skipped. Applying fallback truncation.");
                    // Fallback assigned below
                    updatedCache = null; // Invalidate cache on fallback
                }
            }
        } else {
             console.log("[buildOptimizedHistory P4] Summarization disabled by setting. Applying simple truncation.");
             updatedCache = null; // Summarization disabled, ensure no cache is used/returned
        }

        // Fallback Truncation (used if summarization disabled OR if summarization failed)
        if (finalHistory.length === 0) { // Only run truncation if summarization didn't populate finalHistory
            let truncatedHistoryFallback = [...fullHistory];
            while (truncatedHistoryFallback.length > 0) {
                const historyWithPrompt = systemPromptMessage ? [systemPromptMessage, ...truncatedHistoryFallback] : truncatedHistoryFallback;
                // Check against the overall target limit for truncation
                if (countTokensForMessages(historyWithPrompt) <= targetTokenLimit) {
                    break;
                }
                truncatedHistoryFallback.shift();
            }
            console.log(`[buildOptimizedHistory P4] Fallback truncated ${fullHistory.length - truncatedHistoryFallback.length} messages.`);
            finalHistory = systemPromptMessage ? [systemPromptMessage, ...truncatedHistoryFallback] : truncatedHistoryFallback;
        }
    }

    // Final check: Ensure the constructed history doesn't exceed the *model's* actual limit
    const finalTokenCount = countTokensForMessages(finalHistory);
    if (finalTokenCount > modelContextLimit) {
         console.warn(`[buildOptimizedHistory P4] Final constructed history (${finalTokenCount} tokens) still exceeds model limit (${modelContextLimit}). Applying emergency truncation.`);
         let emergencyTruncated = [...finalHistory];
         const initialMessage = emergencyTruncated.shift();
         while(emergencyTruncated.length > 0) {
            if (countTokensForMessages([initialMessage, ...emergencyTruncated]) <= modelContextLimit) break;
            emergencyTruncated.shift();
         }
         finalHistory = [initialMessage, ...emergencyTruncated];
         updatedCache = null; // Invalidate cache if emergency truncation happens
    }

    console.log(`[buildOptimizedHistory P4] Final history length: ${finalHistory.length}, Tokens: ${countTokensForMessages(finalHistory)}`);
    const historyWithoutSystemPrompt = systemPromptMessage && finalHistory[0]?.role === 'system' ? finalHistory.slice(1) : finalHistory;

    return { history: historyWithoutSystemPrompt, updatedCache: updatedCache };
}


module.exports = {
    buildOptimizedHistory,
}; 