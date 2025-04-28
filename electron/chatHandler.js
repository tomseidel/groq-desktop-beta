const https = require('https'); // Use standard HTTPS module
const { extractTextFromFile } = require('./fileExtractor'); // Import the extractor
const { handleExecuteToolCall } = require('./toolHandler'); // Import tool executor
const { buildOptimizedHistory } = require('./contextHandler'); // Import the new context handler function

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
 * @param {object} mcpClients - Object mapping server IDs to active MCP client instances.
 * @param {string} chatId - The unique ID of the current chat session.
 * @param {Function} updateTempCacheCallback - Callback function to update the temp cache in main.js.
 * @param {object | null} cachedSummaryFromMain - The cached summary object loaded from the chat file.
 */
async function handleChatStream(event, messages, model, settings, platformModels, discoveredTools, selectedPlatform, mcpClients, chatId, updateTempCacheCallback, cachedSummaryFromMain) {
    // Assume selectedPlatform is passed in now, along with settings containing relevant API keys.
    console.log(`Handling chat-stream request. ChatID: ${chatId}, Platform: ${selectedPlatform}, Model: ${model || 'using settings'}, Messages: ${messages?.length}`);
    console.log(`Received initial cache: ${cachedSummaryFromMain ? JSON.stringify(cachedSummaryFromMain) : 'None'}`); // Log received cache

    // State for the current turn, including tool call handling
    let accumulatedContent = ""; // Text content from the model
    let pendingToolCalls = []; // Array to assemble tool calls as chunks arrive
    let processedToolResults = []; // Array to store results from executed tools

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

        // Clean and prepare messages for the API
        // --- Add logic to strip images from older messages ---
        const lastUserMessageIndex = messages.map(m => m.role).lastIndexOf('user');
        // --- End logic --- 
        
        const cleanedMessages = await Promise.all(messages.map(async (msg, index) => {
            const cleanMsg = { ...msg };
            delete cleanMsg.reasoning;
            delete cleanMsg.isStreaming;
            let finalMsg = { ...cleanMsg };

            // Ensure user message content is an array of parts
            if (finalMsg.role === 'user') {
                const isLastUserMessage = index === lastUserMessageIndex;
                
                let processedContent = []; // Build a new content array

                if (typeof finalMsg.content === 'string') {
                    processedContent.push({ type: 'text', text: finalMsg.content });
                } else if (Array.isArray(finalMsg.content)) {
                    // Use Promise.all to handle potential async extraction
                    processedContent = await Promise.all(finalMsg.content.map(async (part) => {
                        // --- Handle Received File Content/Error --- 
                        if (part.type === 'file_content') {
                            console.log(`[chatHandler] Including content from file: ${part.name}`);
                            // Format as text part for the API
                            return { type: 'text', text: `[Content of file: ${part.name}]

${part.content}` }; // Ensure content is included
                        } else if (part.type === 'file_error') {
                             console.warn(`[chatHandler] Including error for file: ${part.name}`);
                             // Format as text part indicating error
                             return { type: 'text', text: `[Error processing file: ${part.name}: ${part.error}]` };
                        } 
                        // --- Handle Image Stripping & Existing Logic ---
                        else if (part.type === 'image_url' && !isLastUserMessage) {
                            console.log(`Stripping image from older user message (index ${index})`);
                            return null; // Mark for removal
                        } else if (part.type === 'image_url' && part.image_url && typeof part.image_url === 'string') {
                            console.warn("Correcting image_url format for OpenAI compatibility.");
                            return { type: 'image_url', image_url: { url: part.image_url } };
                        } 
                        // Add media_type for OpenRouter if needed (existing logic)
                        else if (selectedPlatform === 'openrouter' && part.type === 'image_url' && part.image_url && !part.image_url.media_type) {
                           // ... (existing media_type logic) ...
                        }
                        // Keep other parts (like regular text)
                        return { type: part.type || 'text', ...part }; 
                    }));
                    // Filter out null parts (removed images)
                    processedContent = processedContent.filter(part => part !== null);
                } else {
                    console.warn('Unexpected user message content format, defaulting:', finalMsg.content);
                    processedContent = [{ type: 'text', text: '' }];
                }
                 
                finalMsg.content = processedContent; // Assign the processed content array
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
        }));

        // --- Prepare System Prompt --- (Moved slightly earlier to pass to buildOptimizedHistory)
        let systemPromptContent = "You are a helpful assistant capable of using tools. Use tools only when necessary and relevant to the user's request. Format responses using Markdown.";
        if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
            systemPromptContent += `\n\n${settings.customSystemPrompt.trim()}`;
            console.log("Appending custom system prompt.");
        }
        // Determine if system prompt should be omitted entirely for the API call (Groq Vision)
        const omitSystemPromptForVision = selectedPlatform === 'groq' && hasImages && modelInfo.vision_supported;
        console.log(`Omit system prompt for vision: ${omitSystemPromptForVision} (Platform: ${selectedPlatform}, Has Images: ${hasImages}, Vision Supported: ${modelInfo.vision_supported})`);
        const systemPromptForOptimizing = !omitSystemPromptForVision ? { role: "system", content: systemPromptContent } : null;
        // --- End System Prompt Prep ---

        // --- Ensure Context Fits using Accurate Token Count & Optimization ---
        const contextLimit = modelInfo.context || 8192; // Use model context or default
        // Use the cache passed from main.js
        const currentCachedSummary = cachedSummaryFromMain; // <-- Use the passed argument

        // buildOptimizedHistory is now async and returns an object
        const { history: messagesForApi, updatedCache: cacheAfterFirstCall } = await buildOptimizedHistory(
            cleanedMessages,           // Pass the prepared (but full) message history
            systemPromptForOptimizing, // Pass the system prompt object (or null if omitted)
            contextLimit,              // Pass the actual model context limit
            modelToUse,                // Pass modelId for logging
            currentCachedSummary,      // Pass the current cache state (null for now)
            settings.openrouterApiKey,  // Pass the API key needed for summarization
            settings.contextTargetTokenLimit,    // Pass target token limit setting
            settings.contextEnableSummarization // Pass enable summarization setting
        );

        // Send updated cache back to main process using the callback
        if (cacheAfterFirstCall !== currentCachedSummary) {
            console.log(`[chatHandler] Context summary cache updated after 1st call for chat ${chatId}. Calling update callback.`);
            if (updateTempCacheCallback) { // Check if callback exists
                 updateTempCacheCallback(chatId, cacheAfterFirstCall);
            } else {
                 console.error("[chatHandler] updateTempCacheCallback is missing!");
            }
        }
        // --- End Context Fitting/Optimization ---

        // --- Prepare API Request Body --- (Moved system prompt construction down)
        const apiRequestBody = {
            messages: [
                // Conditionally add system prompt *based on the same vision check*
                ...(systemPromptForOptimizing ? [systemPromptForOptimizing] : []),
                ...messagesForApi // Use the potentially truncated list from buildOptimizedHistory
            ],
            model: modelToUse,
            temperature: settings.temperature ?? 0.7,
            top_p: settings.top_p ?? 0.95,
            ...(tools.length > 0 && { tools: tools, tool_choice: "auto" }),
            stream: true,
            ...(settings.max_tokens && { max_tokens: parseInt(settings.max_tokens, 10) }),
        };

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
            let finalFinishReason = null; // Capture the finish reason
            let capturedModel = null; // Capture the model used
            let accumulatedReasoning = null; // Store reasoning if applicable
            let isFirstChunk = true;
            let streamId = `stream_${Date.now()}`; // Generate a simple ID
            let generationId = null;

            res.on('data', (chunk) => {
                if (requestAborted) return;
                buffer += chunk;
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const message = buffer.substring(0, boundary);
                    buffer = buffer.substring(boundary + 2);
                    boundary = buffer.indexOf('\n\n');

                    if (message.startsWith('data: ')) {
                        const dataContent = message.substring(6).trim();
                        //console.log("[RAW STREAM DATA]:", dataContent);

                        if (dataContent === '[DONE]') {
                            // Mark as done, final processing happens in res.on('end')
                            //console.log(`[DONE] received for stream ${streamId}. Final processing in 'end' handler.`);
                            // We don't set requestAborted here, let 'end' handle final state
                            return; 
                        }

                        try {
                            const jsonChunk = JSON.parse(dataContent);
                            capturedModel = jsonChunk.model || capturedModel; // Capture model name

                            if (jsonChunk.choices && jsonChunk.choices.length > 0) {
                                const choice = jsonChunk.choices[0];
                                const delta = choice.delta;

                                if (isFirstChunk) {
                                    streamId = jsonChunk.id || streamId; 
                                    if (streamId.startsWith('gen-')) {
                                        generationId = streamId;
                                        console.log(`Captured Generation ID: ${generationId}`);
                                    }
                                    event.sender.send('chat-stream-start', {
                                        id: streamId,
                                        role: delta?.role || "assistant",
                                        model: capturedModel,
                                    });
                                    isFirstChunk = false;
                                }

                                if (delta?.content) {
                                    accumulatedContent += delta.content;
                                    event.sender.send('chat-stream-content', { id: streamId, content: delta.content });
                                }

                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                    for (const toolCallDelta of delta.tool_calls) {
                                        let existingCall = pendingToolCalls.find(tc => tc.index === toolCallDelta.index);
                                        if (!existingCall && toolCallDelta.index !== undefined) {
                                            pendingToolCalls.push({
                                                index: toolCallDelta.index,
                                                id: toolCallDelta.id || null,
                                                type: toolCallDelta.type || 'function',
                                                function: {
                                                    name: toolCallDelta.function?.name || "",
                                                    arguments: toolCallDelta.function?.arguments || ""
                                                }
                                            });
                                        } else if (existingCall) {
                                            if (toolCallDelta.id) existingCall.id = toolCallDelta.id;
                                            if (toolCallDelta.function?.name) existingCall.function.name = toolCallDelta.function.name;
                                            if (toolCallDelta.function?.arguments) existingCall.function.arguments += toolCallDelta.function.arguments;
                                        } else {
                                            console.warn("Received tool call delta without index or matching existing call:", toolCallDelta);
                                        }
                                    }
                                    const sanitizedToolCalls = JSON.parse(JSON.stringify(pendingToolCalls)).map(tc => { delete tc.index; return tc; });
                                    event.sender.send('chat-stream-tool-calls', { id: streamId, tool_calls: sanitizedToolCalls });
                                }

                                if (choice.finish_reason) {
                                    finalFinishReason = choice.finish_reason; // Capture finish reason
                                    console.log(`Captured finish_reason: ${finalFinishReason} for stream ${streamId}`);
                                    // Ensure final tool call IDs are updated if they arrive with finish reason
                                    if (delta?.tool_calls) {
                                        delta.tool_calls.forEach(finalDelta => {
                                           const call = pendingToolCalls.find(tc => tc.index === finalDelta.index);
                                           if(call && finalDelta.id) call.id = finalDelta.id;
                                        });
                                    }
                                    // Don't return yet, let res.on('end') handle completion
                                }
                            }
                        } catch (parseError) {
                            console.error('Error parsing SSE data chunk:', parseError, 'Data:', dataContent);
                        }
                    }
                } 
            }); 

            res.on('end', async () => { 
                console.log(`Stream ${streamId} ended.`);
                if (requestAborted) return; // Already handled (e.g., error)
                requestAborted = true; // Mark as handled

                // Determine final reason if not explicitly captured
                if (!finalFinishReason) {
                    if (pendingToolCalls.length > 0) {
                        console.warn(`Stream ${streamId} ended without explicit finish_reason, inferring 'tool_calls'.`);
                        finalFinishReason = 'tool_calls';
                    } else {
                        console.warn(`Stream ${streamId} ended without explicit finish_reason, inferring 'stop'.`);
                        finalFinishReason = 'stop'; // Or 'length'? Defaulting to 'stop'
                    }
                }

                // --- TOOL CALL EXECUTION LOGIC --- 
                if (finalFinishReason === 'tool_calls' && pendingToolCalls.length > 0) {
                    console.log(`Executing ${pendingToolCalls.length} tool calls for stream ${streamId}...`);

                    // 1. Finalize Tool Calls (ensure args are valid JSON, IDs are present)
                    const finalizedToolCalls = [];
                    let parsingError = false;
                    for (const call of pendingToolCalls) {
                        if (!call.id) {
                             console.error(`Tool call at index ${call.index} missing final ID.`);
                             // Assign a placeholder or skip? For now, skip and report error later?
                             // Potentially send error back to renderer?
                             parsingError = true;
                             break; // Stop processing tools if one is broken
                        }
                        try {
                            JSON.parse(call.function.arguments || '{}'); // Validate JSON
                            // Add the finalized call (without index) to list for assistant message
                            finalizedToolCalls.push({
                                id: call.id,
                                type: call.type,
                                function: {
                                    name: call.function.name,
                                    arguments: call.function.arguments
                                }
                            });
                        } catch (e) {
                            console.error(`Invalid JSON arguments for tool ${call.function.name} (ID: ${call.id}): ${e.message}`);
                            parsingError = true;
                            // Send error back? For now, stop processing.
                            event.sender.send('chat-stream-error', { error: `Model generated invalid arguments for tool ${call.function.name}.` });
                            break;
                        }
                    }

                    if (parsingError) {
                        console.error("Aborting tool execution due to parsing errors.");
                        return; // Stop if any tool call is invalid
                    }

                    // 2. Create initial assistant message history entry
                    const initialAssistantMessage = {
                        role: "assistant",
                        content: accumulatedContent || null, // Content can be null if only tool calls
                        tool_calls: finalizedToolCalls
                    };
                    let currentMessageHistory = [...messagesForApi, initialAssistantMessage]; // Start building history for the *next* call

                    // 3. Execute tools sequentially and collect results
                    processedToolResults = []; // Clear previous results if any
                    for (const toolToExecute of finalizedToolCalls) {
                        console.log(`Executing tool: ${toolToExecute.function.name} (ID: ${toolToExecute.id})`);
                        try {
                            // Send start notification to frontend
                             event.sender.send('tool-call-start', { 
                                callId: toolToExecute.id, 
                                name: toolToExecute.function.name, 
                                args: JSON.parse(toolToExecute.function.arguments || '{}') // Send parsed args 
                            });

                            const toolResult = await handleExecuteToolCall(
                                event, // Pass event for potential IPC within handler?
                                toolToExecute, 
                                discoveredTools,
                                mcpClients // Pass the mcpClients object
                            );

                             // Send end notification to frontend
                            event.sender.send('tool-call-end', { 
                                callId: toolToExecute.id, 
                                result: toolResult.result, // Assuming result has { result: ..., tool_call_id: ...} or { error: ..., tool_call_id: ...}
                                error: toolResult.error 
                            });

                            // Format tool result message
                            const toolResponseMessage = {
                                role: "tool",
                                tool_call_id: toolToExecute.id,
                                name: toolToExecute.function.name,
                                content: toolResult.error ? `Error: ${toolResult.error}` : toolResult.result // Content is the stringified result or error
                            };
                            processedToolResults.push(toolResponseMessage);
                            currentMessageHistory.push(toolResponseMessage);
                        } catch (execError) {
                            console.error(`Unexpected error during tool execution flow for ${toolToExecute.function.name}:`, execError);
                            // Send error notification to frontend
                             event.sender.send('tool-call-end', { 
                                callId: toolToExecute.id, 
                                error: `Unexpected handler error: ${execError.message}` 
                            });
                            // Add an error message to history
                            const errorToolMessage = {
                                role: "tool",
                                tool_call_id: toolToExecute.id,
                                name: toolToExecute.function.name,
                                content: `[Internal Handler Error executing tool: ${execError.message}]`
                            };
                             processedToolResults.push(errorToolMessage);
                             currentMessageHistory.push(errorToolMessage);
                             // Potentially stop further execution?
                        }
                    }

                    // 4. Make the second API call
                    console.log(`Making second API call with ${currentMessageHistory.length} messages...`);

                    // Ensure the history for the second call is within context limits *again*
                    // Use buildOptimizedHistory for the second call as well
                    // TODO: Decide if we need to pass/update cache state *between* the two calls in a tool-use turn.
                    // For now, let's assume the state before the *first* call is relevant, or pass null.
                    // Passing the state *after* the first call might be more correct if summarization happened.
                    const { history: secondCallOptimizedHistory, updatedCache: cacheAfterSecondCall } = await buildOptimizedHistory(
                        currentMessageHistory,      // Use the history *including* initial assistant msg + tool results
                        systemPromptForOptimizing, // Pass the same system prompt object
                        contextLimit,
                        modelToUse,
                        cacheAfterFirstCall,      // Pass the cache state *after* the first optimization
                        settings.openrouterApiKey, // Pass API key
                        settings.contextTargetTokenLimit,    // Pass target token limit setting
                        settings.contextEnableSummarization // Pass enable summarization setting
                    );

                    // Send updated cache back to main process using the callback (after second call)
                    if (cacheAfterSecondCall !== cacheAfterFirstCall) {
                        console.log(`[chatHandler] Context summary cache updated after 2nd call for chat ${chatId}. Calling update callback.`);
                         if (updateTempCacheCallback) { // Check if callback exists
                              updateTempCacheCallback(chatId, cacheAfterSecondCall);
                         } else {
                              console.error("[chatHandler] updateTempCacheCallback is missing!");
                         }
                    }

                    const secondApiRequestBody = {
                        messages: [
                             ...(systemPromptForOptimizing ? [systemPromptForOptimizing] : []),
                             ...secondCallOptimizedHistory // Use the optimized history
                        ],
                        model: modelToUse,
                        temperature: settings.temperature ?? 0.7,
                        top_p: settings.top_p ?? 0.95,
                        // No tools/tool_choice in the second call, we expect text
                        stream: true,
                        ...(settings.max_tokens && { max_tokens: parseInt(settings.max_tokens, 10) }),
                    };

                    // --- Make the second HTTPS request ---
                    const secondReq = https.request({
                        hostname: apiHostname,
                        path: apiPath,
                        method: 'POST',
                        headers: { /* ... same headers as before ... */ 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                            'Accept': 'text/event-stream', 
                            'Connection': 'keep-alive',
                            ...(selectedPlatform === 'openrouter' && { 
                                'HTTP-Referer': settings.openrouterReferrer || 'https://github.com/YourApp/GroqDesktop',
                                'X-Title': settings.openrouterTitle || 'Groq Desktop (Electron)'
                            })
                        }
                    }, (secondRes) => {
                        console.log(`Second API Response Status: ${secondRes.statusCode}`);
                        if (secondRes.statusCode !== 200) {
                             let errorBody = '';
                             secondRes.on('data', (chunk) => errorBody += chunk);
                             secondRes.on('end', () => {
                                console.error(`Second API Error (${secondRes.statusCode}):`, errorBody);
                                event.sender.send('chat-stream-error', { error: `Second API call failed: ${errorBody || secondRes.statusCode}` });
                                // event.sender.send('turn-complete', { streamId: streamId }); // REMOVED
                            });
                             return;
                        }
                        
                        // *** Send final stream start signal ***
                        event.sender.send('chat-stream-final-start', { id: streamId });

                        secondRes.setEncoding('utf8');
                        let secondBuffer = '';
                        let secondAccumulatedContent = '';
                        let secondFinalReason = null;

                        secondRes.on('data', (chunk) => {
                            secondBuffer += chunk;
                            let b = secondBuffer.indexOf('\n\n');
                            while (b !== -1) {
                                const msg = secondBuffer.substring(0, b);
                                secondBuffer = secondBuffer.substring(b + 2);
                                b = secondBuffer.indexOf('\n\n');
                                if (msg.startsWith('data: ')) {
                                    const data = msg.substring(6).trim();
                                    if (data === '[DONE]') {
                                        secondFinalReason = 'stop'; // Assume stop if DONE
                                        return;
                                    }
                                    try {
                                        const json = JSON.parse(data);
                                        if (json.choices && json.choices[0]?.delta?.content) {
                                            const contentChunk = json.choices[0].delta.content;
                                            secondAccumulatedContent += contentChunk;
                                            // Send final content chunk to frontend
                                            event.sender.send('chat-stream-content', { id: streamId, content: contentChunk }); 
                                        }
                                        if (json.choices && json.choices[0]?.finish_reason) {
                                            secondFinalReason = json.choices[0].finish_reason;
                                        }
                                    } catch (e) { /* ignore parsing errors on second stream? */ }
                                }
                            }
                        });

                        secondRes.on('end', () => {
                            console.log(`Second stream ${streamId} ended. Reason: ${secondFinalReason || 'inferred stop'}`);
                            // Send the *final* completion signal for the turn
                             event.sender.send('chat-stream-complete', {
                                id: streamId,
                                content: secondAccumulatedContent, // Content from the second call
                                role: "assistant",
                                tool_calls: undefined, // No tool calls in the final response
                                finish_reason: secondFinalReason || 'stop',
                            });
                            // event.sender.send('turn-complete'); // REMOVED
                        });
                        secondRes.on('error', (e) => { 
                            console.error('Error during second response streaming:', e);
                            event.sender.send('chat-stream-error', { error: `Network error during second stream: ${e.message}` });
                            // Send turn-complete even if the second stream errors
                            // event.sender.send('turn-complete', { streamId: streamId }); // REMOVED
                        });
                    });
                    secondReq.on('error', (e) => { 
                        console.error('Error making second HTTPS request:', e);
                         event.sender.send('chat-stream-error', { error: `Failed to make second API call: ${e.message}` });
                         // Send turn-complete if the second request fails to even start
                         // event.sender.send('turn-complete', { streamId: streamId }); // REMOVED
                    });
                    secondReq.write(JSON.stringify(secondApiRequestBody));
                    secondReq.end();
                    // --- End second HTTPS request --- 

                } else {
                    // --- NO TOOL CALLS - Just complete the first stream --- 
                    console.log(`Completing stream ${streamId} normally (no tool calls). Reason: ${finalFinishReason}`);
                    event.sender.send('chat-stream-complete', {
                        id: streamId,
                        content: accumulatedContent,
                        role: "assistant",
                        tool_calls: undefined, // No tool calls
                        finish_reason: finalFinishReason,
                    });
                    // Send turn-complete for non-tool-call turns
                    // event.sender.send('turn-complete', { streamId: streamId }); // REMOVED
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