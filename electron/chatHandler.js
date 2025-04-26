const { net } = require('electron'); // Import net
const { pruneMessageHistory } = require('./messageUtils'); // Import pruning logic

// Helper to parse Server-Sent Events (SSE) stream chunks
function parseSSEChunk(chunkStr) {
    const lines = chunkStr.split('\\n').filter(line => line.trim() !== '');
    const events = [];
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const dataContent = line.substring(6).trim();
            if (dataContent === '[DONE]') {
                events.push({ type: 'done' });
            } else {
                try {
                    events.push({ type: 'data', payload: JSON.parse(dataContent) });
                } catch (error) {
                    console.error('Error parsing SSE JSON:', error, 'Data:', dataContent);
                    events.push({ type: 'error', error: 'Failed to parse stream data' });
                }
            }
        }
        // Ignore other lines like 'event:', 'id:', etc. for now
    }
    return events;
}

/**
 * Handles the 'chat-stream' IPC event for streaming chat completions.
 * Now supports dynamic platform selection (Groq/OpenRouter).
 *
 * @param {Electron.IpcMainEvent} event - The IPC event object.
 * @param {Array<object>} messages - The array of message objects for the chat history.
 * @param {string} model - The specific model requested for this completion.
 * @param {object} settings - The current application settings (including selectedPlatform, API keys).
 * @param {object} platformModels - Object containing fetched models for each platform { groq: {...}, openrouter: {...} }.
 * @param {Array<object>} discoveredTools - List of available MCP tools.
 */
async function handleChatStream(event, messages, model, settings, platformModels, discoveredTools) {
    console.log(`Handling chat-stream request. Platform: ${settings.selectedPlatform}, Model: ${model || 'using settings'}, Messages: ${messages?.length}`);

    let apiKey = '';
    let apiHostname = '';
    let apiPath = '';
    const platform = settings.selectedPlatform || 'groq'; // Default to groq

    // --- 1. Determine API details based on platform ---
    if (platform === 'groq') {
        apiKey = settings.groqApiKey;
        apiHostname = 'api.groq.com';
        apiPath = '/openai/v1/chat/completions';
        if (!apiKey || apiKey === "<replace me>") {
            event.sender.send('chat-stream-error', { error: "API key not configured for Groq. Please add your Groq API key in settings." });
            return;
        }
    } else if (platform === 'openrouter') {
        apiKey = settings.openrouterApiKey;
        apiHostname = 'openrouter.ai';
        apiPath = '/api/v1/chat/completions';
         if (!apiKey || apiKey === "<replace me>") {
            event.sender.send('chat-stream-error', { error: "API key not configured for OpenRouter. Please add your OpenRouter API key in settings." });
            return;
        }
    } else {
        event.sender.send('chat-stream-error', { error: `Unsupported platform selected: ${platform}` });
        return;
    }

    try {
        // --- 2. Determine model and capabilities ---
        const modelsForPlatform = platformModels[platform] || {};
        const modelToUse = model || settings.model || Object.keys(modelsForPlatform)[0]; // Use specified, setting, or first available for platform

        if (!modelToUse) {
             event.sender.send('chat-stream-error', { error: `No models available or configured for the selected platform (${platform}). Please check settings or wait for models to load.` });
            return;
        }

        // --- Fallback model info structure ---
        const fallbackDefaultModelInfo = { context: 8192, vision_supported: false };

        // Determine model info, using platform default or absolute default
        const platformDefaultInfo = platformModels['default'] || fallbackDefaultModelInfo;
        const modelInfo = modelsForPlatform[modelToUse] || platformDefaultInfo;

        console.log(`Using model: ${modelToUse} on ${platform} (Context: ${modelInfo.context}, Vision: ${modelInfo.vision_supported})`);

        // --- 3. Check Vision Support ---
        const hasImages = messages.some(msg =>
            msg.role === 'user' &&
            Array.isArray(msg.content) &&
            msg.content.some(part => part.type === 'image_url')
        );

        if (hasImages && !modelInfo.vision_supported) {
            console.warn(`Attempting to use images with non-vision model: ${modelToUse} on ${platform}`);
            event.sender.send('chat-stream-error', { error: `The selected model (${modelToUse}) on ${platform} does not support image inputs.` });
            return;
        }

        // --- 4. Prepare Tools ---
        const tools = (discoveredTools || []).map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema || {}
            }
        }));
        console.log(`Prepared ${tools.length} tools for the API call.`);

        // --- 5. Clean and Prepare Messages ---
        const cleanedMessages = messages.map(msg => {
            const cleanMsg = { ...msg };
            delete cleanMsg.reasoning;
            delete cleanMsg.isStreaming;
            let finalMsg = { ...cleanMsg };

            if (finalMsg.role === 'user') {
                 if (typeof finalMsg.content === 'string') {
                    finalMsg.content = [{ type: 'text', text: finalMsg.content }];
                 } else if (!Array.isArray(finalMsg.content)) {
                    console.warn('Unexpected user message content format, defaulting:', finalMsg.content);
                    finalMsg.content = [{ type: 'text', text: '' }];
                 }
                 // If platform is OpenRouter, ensure image_url parts have media_type if missing
                 if (platform === 'openrouter') {
                     finalMsg.content = finalMsg.content.map(part => {
                         if (part.type === 'image_url' && part.image_url && !part.image_url.media_type) {
                             // Basic check for common image types in data URI
                             if (part.image_url.url?.startsWith('data:image/jpeg')) {
                                 part.image_url.media_type = 'image/jpeg';
                             } else if (part.image_url.url?.startsWith('data:image/png')) {
                                 part.image_url.media_type = 'image/png';
                             } else if (part.image_url.url?.startsWith('data:image/gif')) {
                                  part.image_url.media_type = 'image/gif';
                             } else if (part.image_url.url?.startsWith('data:image/webp')) {
                                 part.image_url.media_type = 'image/webp';
                             } else {
                                 console.warn('Missing media_type for image_url on OpenRouter, attempting default jpeg', part.image_url.url?.substring(0, 50));
                                 part.image_url.media_type = 'image/jpeg'; // Default or raise error?
                             }
                         }
                         return { type: part.type || 'text', ...part };
                     });
                 } else {
                      finalMsg.content = finalMsg.content.map(part => ({ type: part.type || 'text', ...part }));
                 }

            } else if (finalMsg.role === 'assistant') {
                 if (typeof finalMsg.content !== 'string') {
                     if (Array.isArray(finalMsg.content)) {
                         const textContent = finalMsg.content.filter(p => p.type === 'text').map(p => p.text).join('');
                         finalMsg.content = textContent;
                     } else {
                         console.warn('Unexpected assistant message content format, attempting stringify:', finalMsg.content);
                         try { finalMsg.content = JSON.stringify(finalMsg.content); }
                         catch { finalMsg.content = '[Non-string content]'; }
                     }
                 }
            } else if (finalMsg.role === 'tool') {
                if (typeof finalMsg.content !== 'string') {
                    try { finalMsg.content = JSON.stringify(finalMsg.content); }
                    catch (e) {
                        console.warn("Could not stringify tool content:", finalMsg.content, "Error:", e);
                        finalMsg.content = "[Error stringifying tool content]";
                    }
                }
            }
            return finalMsg;
        });

        // --- 6. Prune Message History ---
        // Pass the specific context size for the selected model
        const prunedMessages = pruneMessageHistory(cleanedMessages, modelInfo.context || 8192);
        console.log(`History pruned: ${cleanedMessages.length} -> ${prunedMessages.length} messages using context ${modelInfo.context}.`);

        // --- 7. Construct System Prompt ---
        let systemPrompt = "You are a helpful assistant. Format responses using Markdown.";
        if (tools.length > 0) {
            systemPrompt += " You are capable of using tools. Use tools only when necessary and relevant to the user's request.";
        }
        if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
            systemPrompt += `\\n\\n${settings.customSystemPrompt.trim()}`;
            console.log("Appending custom system prompt.");
        }

        // --- 8. Prepare API Parameters ---
        const apiRequestBody = {
            messages: [
                { role: "system", content: systemPrompt },
                ...prunedMessages
            ],
            model: modelToUse,
            temperature: settings.temperature ?? 0.7,
            top_p: settings.top_p ?? 0.95,
            ...(tools.length > 0 && { tools: tools, tool_choice: "auto" }),
            stream: true
        };

        // Add max_tokens if available in settings
        if (settings.max_tokens && typeof settings.max_tokens === 'number' && settings.max_tokens > 0) {
            apiRequestBody.max_tokens = settings.max_tokens;
            console.log(`Setting max_tokens: ${apiRequestBody.max_tokens}`);
        } else {
            console.log(`Using default max_tokens (not set or invalid in settings).`);
        }

        // --- 9. Setup API Request Headers --- (Moved outside makeRequest for clarity)
        const requestHeaders = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            // OpenRouter specific headers (Optional)
            ...(platform === 'openrouter' && {
                'HTTP-Referer': settings.openrouterReferrer || 'https://github.com/YourApp/GroqDesktop', // Use setting or default
                'X-Title': settings.openrouterTitle || 'Groq Desktop (Modified)' // Use setting or default
                // Consider making referrer/title configurable in settings.js/Settings.jsx
            })
        };

        // --- 10. Streaming and Retry Logic ---
        let retryCount = 0;
        const MAX_TOOL_USE_RETRIES = 3;
        let currentRequestAttempt = null; // To manage request cancellation/retry

        const makeRequest = () => {
            return new Promise((resolve, reject) => {
                 console.log(`Attempting ${platform} completion (attempt ${retryCount + 1}/${MAX_TOOL_USE_RETRIES + 1})...`);

                let accumulatedContent = "";
                let accumulatedToolCalls = [];
                let accumulatedReasoning = null;
                let isFirstChunk = true;
                let streamId = null;
                let finishReason = null;
                let responseStatusCode = null;
                let unprocessedChunkData = ""; // Buffer for partial SSE chunks

                currentRequestAttempt = net.request({
                    method: 'POST',
                    protocol: 'https:',
                    hostname: apiHostname,
                    path: apiPath,
                    headers: requestHeaders // Use defined headers
                });

                currentRequestAttempt.on('response', (response) => {
                    responseStatusCode = response.statusCode;
                    console.log(`${platform} API response status: ${responseStatusCode}`);

                    if (responseStatusCode !== 200) {
                         let errorBody = '';
                         response.on('data', (chunk) => errorBody += chunk.toString());
                         response.on('end', () => {
                              console.error(`Error from ${platform} API: Status ${responseStatusCode}`, 'Body:', errorBody);
                              // Try to parse error details from body if JSON
                              let detailMessage = errorBody.substring(0, 200);
                              try {
                                  const errorJson = JSON.parse(errorBody);
                                  if (errorJson.error?.message) {
                                      detailMessage = errorJson.error.message;
                                  }
                              } catch {}
                              reject(new Error(`API Error: ${responseStatusCode} - ${detailMessage}`)); // Reject promise on non-200 status
                         });
                         return;
                    }

                    // Handle successful stream
                    let accumulatedDataForEvent = ''; // Buffer for current event's data lines

                    response.on('data', (chunk) => {
                        unprocessedChunkData += chunk.toString();
                        let newlineIndex;

                        // Process line by line
                        while ((newlineIndex = unprocessedChunkData.indexOf('\n')) !== -1) {
                            const line = unprocessedChunkData.substring(0, newlineIndex).trim();
                            unprocessedChunkData = unprocessedChunkData.substring(newlineIndex + 1);

                            if (line === '') { // Empty line marks the end of an event
                                if (accumulatedDataForEvent) {
                                    if (accumulatedDataForEvent === '[DONE]') {
                                        console.log(`Stream finished ([DONE] received). ID: ${streamId}`);
                                        finishReason = finishReason || 'stop';
                                        resolve({ content: accumulatedContent, tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined, reasoning: accumulatedReasoning, finish_reason: finishReason });
                                        accumulatedDataForEvent = ''; // Reset buffer
                                        // Don't abort here, let 'end' handle it
                                        return; // Stop processing this chunk
                                    } else {
                                        try {
                                            const payload = JSON.parse(accumulatedDataForEvent);
                                            accumulatedDataForEvent = ''; // Reset buffer after successful parse

                                            // --- Process Parsed Payload --- //
                                            if (!payload.choices || !payload.choices.length || !payload.choices[0]) continue;

                                            const choice = payload.choices[0];
                                            const delta = choice.delta;

                                            if (isFirstChunk && payload.id) {
                                                streamId = payload.id;
                                                event.sender.send('chat-stream-start', { id: streamId, role: delta?.role || "assistant" });
                                                isFirstChunk = false;
                                            }

                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                event.sender.send('chat-stream-content', { content: delta.content });
                                            }

                                            if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                                // (Existing tool_calls accumulation logic - slightly adapted)
                                                for (const toolCallDelta of delta.tool_calls) {
                                                    let existingCall = accumulatedToolCalls.find(tc => tc.index === toolCallDelta.index);
                                                    if (!existingCall) {
                                                        if (toolCallDelta.index !== undefined && toolCallDelta.index !== null) {
                                                            accumulatedToolCalls.push({
                                                                index: toolCallDelta.index,
                                                                id: toolCallDelta.id || `tool_${Date.now()}_${toolCallDelta.index}`,
                                                                type: toolCallDelta.type || 'function',
                                                                function: { name: toolCallDelta.function?.name || "", arguments: toolCallDelta.function?.arguments || "" }
                                                            });
                                                        } else { console.warn("Received tool_call delta without index:", toolCallDelta); }
                                                    } else {
                                                        if (toolCallDelta.function?.arguments) existingCall.function.arguments += toolCallDelta.function.arguments;
                                                        if (toolCallDelta.function?.name) existingCall.function.name = toolCallDelta.function.name;
                                                        if (toolCallDelta.id) existingCall.id = toolCallDelta.id;
                                                    }
                                                }
                                                // Send accumulated *completed* tool calls - structure might need review based on how they arrive
                                                const completedToolCalls = accumulatedToolCalls.filter(tc => tc.id && tc.function.name && tc.function.arguments /* or some end signal? */);
                                                if (completedToolCalls.length > 0) {
                                                     event.sender.send('chat-stream-tool-calls', { tool_calls: completedToolCalls });
                                                }
                                            }

                                            if (choice.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                console.log(`Stream completion indicated in payload. Reason: ${finishReason}, ID: ${streamId}`);
                                                if (finishReason === 'length') { // Resolve early on length limit
                                                    resolve({ content: accumulatedContent, tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined, reasoning: accumulatedReasoning, finish_reason: finishReason });
                                                    return; // Exit handler
                                                }
                                            }
                                            // --- End Process Parsed Payload --- //

                                        } catch (error) {
                                            console.error('Error parsing accumulated SSE data JSON:', error, 'Data:', accumulatedDataForEvent);
                                            event.sender.send('chat-stream-error', { error: 'Failed to parse stream data chunk' });
                                            accumulatedDataForEvent = ''; // Reset buffer even on error
                                            // Consider rejecting the promise or stopping? For now, log and continue.
                                        }
                                    }
                                } // end if(accumulatedDataForEvent)
                            } else if (line.startsWith('data:')) {
                                const dataPart = line.substring(5).trim(); // Get content after 'data: '
                                accumulatedDataForEvent += dataPart; // Append to buffer
                                // Note: No newline added here, assumes JSON parser handles concatenated data if needed.
                                // If multi-line JSON is expected, a newline might be needed: accumulatedDataForEvent += (accumulatedDataForEvent ? '\n' : '') + dataPart;
                            } else {
                                // Ignore other lines like id:, event:, : (comment)
                            }
                        } // End while loop for processing lines in buffer
                    }); // End response.on('data')

                    response.on('end', () => {
                        console.log(`Stream response ended. ID: ${streamId}. Finish Reason: ${finishReason}`);
                        // If stream ends without [DONE] or explicit finish_reason, resolve with what we have
                         if (finishReason) {
                             resolve({
                                 content: accumulatedContent,
                                 tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                                 reasoning: accumulatedReasoning,
                                 finish_reason: finishReason
                             });
                         } else {
                             // If stream just ends without a clear signal (unlikely but possible)
                             console.warn("Stream ended without explicit finish reason or [DONE]. Resolving with current state as 'stop'.");
                             resolve({
                                 content: accumulatedContent,
                                 tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                                 reasoning: accumulatedReasoning,
                                 finish_reason: 'stop' // Assume stop if no other reason given
                             });
                         }
                    });

                    response.on('error', (error) => {
                        console.error(`Error during ${platform} API stream response:`, error);
                        reject(error); // Reject promise on response error
                    });
                }); // End request.on('response')

                currentRequestAttempt.on('error', (error) => {
                    // Ignore ECONNRESET if it happens after we already resolved/rejected (e.g., during abort)
                    if (error.code === 'ECONNRESET' && (finishReason || responseStatusCode !== 200)) {
                        console.log('Ignoring ECONNRESET after stream completion/error.');
                        return;
                    }
                    console.error(`Error making ${platform} API request:`, error);
                    reject(error); // Reject promise on request error
                });

                // Write the request body and end the request
                currentRequestAttempt.write(JSON.stringify(apiRequestBody));
                currentRequestAttempt.end();
            }); // End Promise
        }; // End makeRequest function


        // --- Execution and Retry Loop ---
        while (retryCount <= MAX_TOOL_USE_RETRIES) {
            try {
                const result = await makeRequest(); // Await the promise from makeRequest
                // If makeRequest resolved successfully, send completion and exit
                event.sender.send('chat-stream-complete', {
                    content: result.content,
                    role: "assistant",
                    tool_calls: result.tool_calls,
                    reasoning: result.reasoning,
                    finish_reason: result.finish_reason
                });
                return; // Successful completion

            } catch (error) {
                // Check if it's a tool_use_failed error (adjust condition if OpenRouter signals differently)
                const isToolUseFailedError = (
                    error?.finish_reason === 'tool_calls' || // Example: OpenAI style
                    error?.message?.includes('tool_use_failed') || // Example: Groq style
                    (error?.message?.includes('API Error') && (error.message.includes('tool') || error.message.includes('function calling')))
                    // Add specific OpenRouter error codes/messages if known
                 ) && finishReason !== 'length'; // Don't retry if it was a length limit issue

                if (isToolUseFailedError && retryCount < MAX_TOOL_USE_RETRIES) {
                    retryCount++;
                    console.warn(`Tool use likely failed. Retrying (${retryCount}/${MAX_TOOL_USE_RETRIES})... Error:`, error.message);
                    // Optional delay? await new Promise(resolve => setTimeout(resolve, 500));
                    continue; // Retry the while loop
                }

                // Handle other errors or exhausted retries
                console.error(`Error during ${platform} stream processing or retries exhausted:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                event.sender.send('chat-stream-error', {
                    error: `Failed to get chat completion from ${platform}: ${errorMessage}`,
                    // Avoid sending potentially large/complex error objects directly
                    // details: error
                });
                return; // Exit after sending error
            }
        } // End while loop

        // If retries exhausted
        if (retryCount > MAX_TOOL_USE_RETRIES) {
             console.error(`Max retries (${MAX_TOOL_USE_RETRIES}) exceeded for tool_use_failed error on ${platform}.`);
             event.sender.send('chat-stream-error', { error: `The model repeatedly failed to use tools correctly after ${MAX_TOOL_USE_RETRIES + 1} attempts. Please try rephrasing your request.` });
         }

    } catch (outerError) {
        // Catch errors during setup (e.g., model lookup, message prep)
        console.error('Error setting up chat completion stream:', outerError);
        event.sender.send('chat-stream-error', { error: `Setup error: ${outerError.message}` });
    }
}

module.exports = {
    handleChatStream
}; 