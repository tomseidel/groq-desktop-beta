const https = require('https'); // Use standard HTTPS module
const { pruneMessageHistory } = require('./messageUtils');

/**
 * Handles the 'chat-stream' IPC event for streaming chat completions using OpenAI-compatible APIs.
 *
 * @param {Electron.IpcMainEvent} event - The IPC event object.
 * @param {Array<object>} messages - The array of message objects for the chat history.
 * @param {string} model - The specific model requested for this completion.
 * @param {object} settings - The current application settings (needs groqApiKey, openrouterApiKey, selectedPlatform, etc.).
 * @param {object} platformModels - Object containing fetched models for each platform { groq: {...}, openrouter: {...} }.
 * @param {Array<object>} discoveredTools - List of available MCP tools.
 * @param {string} selectedPlatform - The selected platform ('groq' or 'openrouter'). Passed explicitly.
 */
async function handleChatStream(event, messages, model, settings, platformModels, discoveredTools, selectedPlatform) {
    // Assume selectedPlatform is passed in now, along with settings containing relevant API keys.
    console.log(`Handling chat-stream request. Platform: ${selectedPlatform}, Model: ${model || 'using settings'}, Messages: ${messages?.length}`);

    try {
        let apiKey;
        let apiHostname;
        let apiPath;

        // --- Platform Specific Configuration ---
        if (selectedPlatform === 'groq') {
            apiKey = settings.groqApiKey; // Use the key name from the new main.js
            apiHostname = 'api.groq.com';
            apiPath = '/openai/v1/chat/completions';
            if (!apiKey || apiKey === "<replace me>") { // Adjust key check if necessary
                event.sender.send('chat-stream-error', { error: "API key not configured for Groq. Please add your Groq API key in settings." });
                return;
            }
            console.log("Configured for Groq (OpenAI Compatible Endpoint)");
        } else if (selectedPlatform === 'openrouter') {
            apiKey = settings.openrouterApiKey;
            apiHostname = 'openrouter.ai';
            apiPath = '/api/v1/chat/completions';
            if (!apiKey) {
                event.sender.send('chat-stream-error', { error: "API key not configured for OpenRouter. Please add your OpenRouter API key in settings." });
                return;
            }
            console.log("Configured for OpenRouter");
        } else {
            event.sender.send('chat-stream-error', { error: `Unsupported platform selected: ${selectedPlatform || 'none'}` });
            return;
        }
        // --- End Platform Specific Configuration ---

        // Get models for the selected platform
        const modelsForPlatform = platformModels[selectedPlatform] || {};

        // Determine model to use: prioritise argument, then settings, then fallback based on platform
        const defaultModel = selectedPlatform === 'groq' ? 'llama3-70b-8192' : 'openai/gpt-4o'; // Example defaults
        const modelToUse = model || settings.model || defaultModel; // Note: settings.model might need platform prefix?

        // Get specific model info from the fetched models
        const modelInfo = modelsForPlatform[modelToUse] || { id: modelToUse, name: modelToUse, context: 8192, vision_supported: false }; // Basic fallback if model not found
        console.log(`Using model: ${modelToUse} (Context: ${modelInfo.context}, Vision: ${modelInfo.vision_supported})`);

        // Check for vision support if images are present (using fetched model info)
        const hasImages = messages.some(msg =>
            msg.role === 'user' &&
            Array.isArray(msg.content) &&
            msg.content.some(part => part.type === 'image_url')
        );

        if (hasImages && !modelInfo.vision_supported) {
            console.warn(`Attempting to use images with non-vision model: ${modelToUse}`);
            event.sender.send('chat-stream-error', { error: `The selected model (${modelToUse}) does not support image inputs. Please select a vision-capable model.` });
            return;
        }

        // --- Removed Groq SDK Initialization ---

        // Prepare tools for the API call (remains largely the same, follows OpenAI format)
        const tools = (discoveredTools || []).map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema || {} // Ensure parameters is an object
            }
        }));
        console.log(`Prepared ${tools.length} tools for the API call.`);

        // Clean and prepare messages for the API (remains the same)
        const cleanedMessages = messages.map(msg => {
            const cleanMsg = { ...msg };
            delete cleanMsg.reasoning;
            delete cleanMsg.isStreaming;
            let finalMsg = { ...cleanMsg };

            // Ensure user message content is an array of parts
            if (finalMsg.role === 'user') {
                if (typeof finalMsg.content === 'string') {
                    finalMsg.content = [{ type: 'text', text: finalMsg.content }];
                } else if (!Array.isArray(finalMsg.content)) {
                    console.warn('Unexpected user message content format, defaulting:', finalMsg.content);
                    finalMsg.content = [{ type: 'text', text: '' }];
                }
                 // Ensure all parts have a type and handle image URLs correctly
                 finalMsg.content = finalMsg.content.map(part => {
                    if (part.type === 'image_url' && part.image_url && typeof part.image_url === 'string') {
                        // If image_url is just a string, wrap it in the required object structure
                        console.warn("Correcting image_url format for OpenAI compatibility.");
                        return { type: 'image_url', image_url: { url: part.image_url } };
                    }
                    // Add media_type for OpenRouter if needed (heuristic based example)
                    if (selectedPlatform === 'openrouter' && part.type === 'image_url' && part.image_url && !part.image_url.media_type) {
                        // Basic check based on common base64 prefix or file extension
                        const url = part.image_url.url;
                        if (url && typeof url === 'string') {
                            if (url.startsWith('data:image/jpeg')) part.image_url.media_type = 'image/jpeg';
                            else if (url.startsWith('data:image/png')) part.image_url.media_type = 'image/png';
                            else if (url.startsWith('data:image/gif')) part.image_url.media_type = 'image/gif';
                            else if (url.startsWith('data:image/webp')) part.image_url.media_type = 'image/webp';
                            else console.warn("Could not determine media_type for OpenRouter image URL");
                        }
                    }
                    return { type: part.type || 'text', ...part };
                });
            }

            // Ensure assistant message content is a string (or null if only tool_calls)
            if (finalMsg.role === 'assistant') {
                 if (finalMsg.tool_calls && !finalMsg.content) {
                    // OpenAI requires content to be null if there are tool calls and no text
                     finalMsg.content = null;
                 } else if (typeof finalMsg.content !== 'string') {
                    if (Array.isArray(finalMsg.content)) {
                        const textContent = finalMsg.content.filter(p => p.type === 'text').map(p => p.text).join('');
                        finalMsg.content = textContent || null; // Be null if only non-text parts existed
                    } else {
                        console.warn('Unexpected assistant message content format, attempting stringify:', finalMsg.content);
                        try {
                            finalMsg.content = JSON.stringify(finalMsg.content);
                        } catch { finalMsg.content = '[Non-string content]'; }
                    }
                }
            }

            // Ensure tool message content is stringified if not already
            if (finalMsg.role === 'tool' && typeof finalMsg.content !== 'string') {
                try {
                    finalMsg.content = JSON.stringify(finalMsg.content);
                } catch (e) {
                    console.warn("Could not stringify tool content:", finalMsg.content, "Error:", e);
                    finalMsg.content = "[Error stringifying tool content]";
                }
            }
            // Ensure tool_call_id is present for tool role messages
            if (finalMsg.role === 'tool' && !finalMsg.tool_call_id) {
                 console.warn("Tool message missing tool_call_id, adding placeholder:", finalMsg);
                 finalMsg.tool_call_id = `missing_${Date.now()}`; // Add a placeholder if missing
            }


            return finalMsg;
        });

        // Prune message history (passing model ID and available model info)
        const prunedMessages = pruneMessageHistory(cleanedMessages, modelToUse, modelsForPlatform);
        //console.log(`History pruned: ${cleanedMessages.length} -> ${prunedMessages.length} messages.`);

        // Construct the system prompt (remains the same)
        let systemPrompt = "You are a helpful assistant capable of using tools. Use tools only when necessary and relevant to the user's request. Format responses using Markdown.";
        if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
            systemPrompt += `\n\n${settings.customSystemPrompt.trim()}`;
            console.log("Appending custom system prompt.");
        }

        // Prepare OpenAI-compatible API parameters
        const apiRequestBody = {
            messages: [
                { role: "system", content: systemPrompt },
                ...prunedMessages
            ],
            model: modelToUse,
            temperature: settings.temperature ?? 0.7,
            top_p: settings.top_p ?? 0.95,
            ...(tools.length > 0 && { tools: tools, tool_choice: "auto" }),
            stream: true,
            // Add max_tokens if available in settings?
             ...(settings.max_tokens && { max_tokens: parseInt(settings.max_tokens, 10) }),
        };

        // --- Log the request body before sending ---
        console.log('*** API Request Body Messages: ***\n', JSON.stringify(apiRequestBody.messages, null, 2));
        // --- End Logging ---

        // --- Streaming and Retry Logic using HTTPS ---
        // Note: Retry logic is simplified (removed while loop) due to complexity with callbacks.
        // Consider implementing Promises for robust retries if needed.
        let retryCount = 0; // Kept for potential future use / logging
        const MAX_TOOL_USE_RETRIES = 3;

        let requestAborted = false; // Flag to track explicit abort
        const req = https.request({
            hostname: apiHostname,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'text/event-stream', // Essential for SSE
                'Connection': 'keep-alive',
                // --- Add OpenRouter specific headers if needed ---
                ...(selectedPlatform === 'openrouter' && {
                    'HTTP-Referer': settings.openrouterReferrer || 'https://github.com/YourApp/GroqDesktop', // Replace with actual repo/app URL
                    'X-Title': settings.openrouterTitle || 'Groq Desktop (Electron)' // Replace with actual App Title
                })
            }
        }, (res) => {
            console.log(`API Response Status: ${res.statusCode}`);

            if (res.statusCode !== 200) {
                let errorBody = '';
                res.on('data', (chunk) => errorBody += chunk);
                res.on('end', () => {
                    console.error(`API Error (${res.statusCode}):`, errorBody);
                     // Check for tool use failed error (adjust based on actual API response structure)
                     // Basic check, may need refinement based on actual error formats from Groq/OpenRouter OpenAI endpoints
                     const isToolUseFailedError = errorBody.toLowerCase().includes('tool_use_failed') || errorBody.toLowerCase().includes('error running tool');

                     // Simplified: No retry loop active, just report error
                     // if (isToolUseFailedError && retryCount < MAX_TOOL_USE_RETRIES) {
                     //    console.warn(`Tool use failed error detected from API response.`);
                     // }
                     event.sender.send('chat-stream-error', {
                         error: `API request failed with status ${res.statusCode}.`,
                         details: errorBody || `Status: ${res.statusCode}`
                     });
                });
                return; // Stop processing response data for non-200 status
            }

            res.setEncoding('utf8');
            let buffer = '';
            let accumulatedContent = "";
            let accumulatedToolCalls = [];
            let accumulatedReasoning = null; // Store reasoning if applicable
            let isFirstChunk = true;
            let streamId = `stream_${Date.now()}`; // Generate a simple ID

            res.on('data', (chunk) => {
                if (requestAborted) return; // Stop processing if already completed or aborted
                buffer += chunk;
                // Process buffer line by line for SSE messages
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const message = buffer.substring(0, boundary);
                    buffer = buffer.substring(boundary + 2); // Skip the \n\n
                    boundary = buffer.indexOf('\n\n');

                    if (message.startsWith('data: ')) {
                        const dataContent = message.substring(6).trim(); // Skip 'data: '
                        if (dataContent === '[DONE]') {
                            // Stream finished signal
                            console.log(`Stream completed via [DONE]. Reason: ${accumulatedToolCalls.length > 0 ? 'tool_calls' : 'stop'}, ID: ${streamId}`);
                            if (!requestAborted) {
                                requestAborted = true;
                                event.sender.send('chat-stream-complete', {
                                    id: streamId, // Use generated ID
                                    content: accumulatedContent,
                                    role: "assistant",
                                    tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls.map(tc => ({ ...tc, index: undefined })) : undefined,
                                    reasoning: accumulatedReasoning,
                                    finish_reason: accumulatedToolCalls.length > 0 ? 'tool_calls' : 'stop' // Infer finish reason
                                });
                                req.abort(); // Ensure connection closes
                            }
                            return; // Stop processing further data chunks
                        }

                        try {
                            const jsonChunk = JSON.parse(dataContent);

                            // --- Process OpenAI formatted chunk ---
                            if (jsonChunk.choices && jsonChunk.choices.length > 0) {
                                const choice = jsonChunk.choices[0];
                                const delta = choice.delta;

                                if (isFirstChunk) {
                                    streamId = jsonChunk.id || streamId; // Capture actual stream ID if available
                                    event.sender.send('chat-stream-start', {
                                        id: streamId,
                                        role: delta?.role || "assistant",
                                        model: jsonChunk.model // Send model used back
                                    });
                                    isFirstChunk = false;
                                }

                                if (delta?.content) {
                                    accumulatedContent += delta.content;
                                    event.sender.send('chat-stream-content', { id: streamId, content: delta.content });
                                }

                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                    // Reuse existing logic for accumulating tool calls
                                    for (const toolCallDelta of delta.tool_calls) {
                                         let existingCall = accumulatedToolCalls.find(tc => tc.index === toolCallDelta.index);
                                         if (!existingCall && toolCallDelta.index !== undefined) { // Need index to track
                                             accumulatedToolCalls.push({
                                                 index: toolCallDelta.index,
                                                 id: toolCallDelta.id || null, // ID might come later
                                                 type: toolCallDelta.type || 'function',
                                                 function: {
                                                     name: toolCallDelta.function?.name || "",
                                                     arguments: toolCallDelta.function?.arguments || ""
                                                 }
                                             });
                                             existingCall = accumulatedToolCalls[accumulatedToolCalls.length - 1];
                                         } else if (existingCall) {
                                             // Update existing call
                                             if (toolCallDelta.id) existingCall.id = toolCallDelta.id;
                                             // Name usually comes all at once, replace is safer than append
                                             if (toolCallDelta.function?.name) existingCall.function.name = toolCallDelta.function.name;
                                             if (toolCallDelta.function?.arguments) existingCall.function.arguments += toolCallDelta.function.arguments; // Append arguments
                                         } else {
                                             console.warn("Received tool call delta without index or matching existing call:", toolCallDelta);
                                         }
                                    }
                                     // Send update with potentially partial tool calls (remove index before sending)
                                     const sanitizedToolCalls = accumulatedToolCalls.map(tc => ({ ...tc, index: undefined }));
                                     event.sender.send('chat-stream-tool-calls', { id: streamId, tool_calls: sanitizedToolCalls });
                                }

                                if (choice.finish_reason) {
                                    console.log(`Stream completed via finish_reason. Reason: ${choice.finish_reason}, ID: ${streamId}`);
                                    if (!requestAborted) {
                                        requestAborted = true;
                                        // Map Groq finish reasons if needed, e.g., 'tool_calls' might come from Groq
                                        const finalFinishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason;

                                        // Ensure final tool call IDs are captured if they arrive with finish reason
                                         if (delta?.tool_calls) {
                                             // Process potential final updates to tool calls here if needed (e.g., ensure IDs are set)
                                             delta.tool_calls.forEach(finalDelta => {
                                                const call = accumulatedToolCalls.find(tc => tc.index === finalDelta.index);
                                                if(call && finalDelta.id) call.id = finalDelta.id;
                                             });
                                         }
                                         const finalSanitizedToolCalls = accumulatedToolCalls.map(tc => ({ ...tc, index: undefined }));

                                        event.sender.send('chat-stream-complete', {
                                            id: streamId,
                                            content: accumulatedContent,
                                            role: "assistant",
                                            tool_calls: finalSanitizedToolCalls.length > 0 ? finalSanitizedToolCalls : undefined,
                                            reasoning: accumulatedReasoning,
                                            finish_reason: finalFinishReason
                                        });
                                        req.abort(); // Ensure connection closes
                                    }
                                    return; // Stop processing
                                }
                            }
                            // --- End Process OpenAI formatted chunk ---

                        } catch (parseError) {
                            console.error('Error parsing SSE data chunk:', parseError, 'Data:', dataContent);
                            // Decide if this is fatal or ignorable noise
                        }
                    }
                } // end while loop for processing buffer
            }); // end res.on('data')

            res.on('end', () => {
                if (!requestAborted) { // Check if already completed via [DONE] or finish_reason
                     console.warn('Stream ended unexpectedly without [DONE] message or finish_reason.');
                     requestAborted = true;
                     // Send completion with whatever was accumulated, maybe with 'length' finish reason?
                     event.sender.send('chat-stream-complete', {
                          id: streamId,
                          content: accumulatedContent,
                          role: "assistant",
                          tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls.map(tc => ({ ...tc, index: undefined })) : undefined,
                          reasoning: accumulatedReasoning,
                          finish_reason: 'length' // Indicate truncation or unexpected end
                      });
                }
            });

            res.on('error', (socketError) => {
                console.error('Error during HTTPS response streaming:', socketError);
                if (!requestAborted) {
                    requestAborted = true;
                    event.sender.send('chat-stream-error', { error: `Network error during stream: ${socketError.message}` });
                }
            });
        }); // end https.request callback

        req.on('error', (requestError) => {
            console.error('Error making HTTPS request:', requestError);
            if (!requestAborted) {
                 requestAborted = true;
                 // Handle specific errors like DNS resolution, connection refused etc.
                 const commonMessages = {
                     'ENOTFOUND': `Could not resolve hostname ${apiHostname}. Check network connection or API endpoint.`,
                     'ECONNREFUSED': `Connection refused by ${apiHostname}. Ensure the API server is running and accessible.`,
                     'ETIMEDOUT': 'Connection timed out.',
                 };
                 const errorMessage = commonMessages[requestError.code] || `Request failed: ${requestError.message}`;

                 event.sender.send('chat-stream-error', { error: errorMessage });
            }
        });

        // Write the request body and end the request
        req.write(JSON.stringify(apiRequestBody));
        req.end();

        // --- Handle Abort from Renderer ---
        // Need a mechanism for the renderer to signal aborting the stream
        // Example: ipcMain.on('chat-stream-abort', (event, streamIdToAbort) => { ... req.abort() ... });
        // For now, no explicit abort handler is implemented here.

    } catch (outerError) {
        // Catch errors during setup (e.g., message prep, initial checks)
        console.error('Error setting up chat completion stream:', outerError);
        event.sender.send('chat-stream-error', { error: `Setup error: ${outerError.message}` });
    }
}

module.exports = {
    handleChatStream
}; 