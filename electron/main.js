const { app, BrowserWindow, ipcMain, screen, shell, net } = require('electron');
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { extractTextFromFile } = require('./fileExtractor');

// Create ~/Library/Logs/Groq Desktop if it does not exist
app.setAppLogsPath();
const logFile = path.join(app.getPath('logs'), 'main.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// Mirror every console.* call to the file
['log', 'info', 'warn', 'error'].forEach(fn => {
  const orig = console[fn].bind(console);
  console[fn] = (...args) => {
    orig(...args);
    logStream.write(args.map(String).join(' ') + '\n');
  };
});

console.log('Groq Desktop started, logging to', logFile);

// Import necessary Electron modules
// const { BrowserWindow, ipcMain, screen, shell, net } = require('electron'); // REMOVED DUPLICATE

// Import shared models
const { MODEL_CONTEXT_SIZES: FALLBACK_MODEL_DEFINITIONS } = require('../shared/models.js');

// Import handlers
const chatHandler = require('./chatHandler');
const toolHandler = require('./toolHandler');

// Import new manager modules
const { initializeSettingsHandlers, loadSettings } = require('./settingsManager');
const { initializeCommandResolver, resolveCommandPath } = require('./commandResolver');
const { initializeMcpHandlers, connectConfiguredMcpServers, getMcpState } = require('./mcpManager');
const { initializeWindowManager } = require('./windowManager');

// Global variable to hold the main window instance
let mainWindow;

// Directory for storing chat files
const CHATS_DIR = path.join(app.getPath('userData'), 'chats');

// Variable to hold loaded model context sizes (Now fetched from APIs)
let platformModels = { groq: {}, openrouter: {} }; // State to hold fetched models

// --- Model Fetching Functions --- //

/**
 * Fetches models from the Groq API.
 * @param {string} apiKey Groq API Key
 * @returns {Promise<object>} Object containing model configurations keyed by model ID.
 */
async function fetchGroqModels(apiKey) {
  if (!apiKey) {
    console.log('Groq API key not provided, skipping model fetch.');
    return {};
  }
  console.log('Fetching Groq models...');
  return new Promise((resolve) => {
    const request = net.request({
      method: 'GET',
      protocol: 'https:',
      hostname: 'api.groq.com',
      path: '/openai/v1/models',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    let body = '';
    request.on('response', (response) => {
      console.log(`Groq API response status: ${response.statusCode}`);
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        if (response.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const models = {};
            if (data && Array.isArray(data.data)) {
              data.data.forEach(model => {
                // Basic mapping - Assuming Groq API follows OpenAI structure for now
                // We might need to supplement this with FALLBACK_MODEL_DEFINITIONS for vision/context if not provided
                const fallback = FALLBACK_MODEL_DEFINITIONS[model.id] || FALLBACK_MODEL_DEFINITIONS['default'];
                models[model.id] = {
                  id: model.id,
                  name: model.id, // Use ID as name for now, API might not provide a friendly name
                  context: fallback.context, // Use fallback context for now
                  vision_supported: fallback.vision_supported, // Use fallback vision support
                  // Add other relevant fields if provided by Groq API
                };
              });
            } else {
                console.warn('Groq API response did not contain expected data structure.', data);
            }
            console.log(`Fetched ${Object.keys(models).length} Groq models.`);
            resolve(models);
          } catch (error) {
            console.error('Error parsing Groq models response:', error, 'Body:', body);
            resolve({});
          }
        } else {
          console.error(`Error fetching Groq models: Status ${response.statusCode}`, 'Body:', body);
          resolve({});
        }
      });
      response.on('error', (error) => {
        console.error('Error during Groq API response:', error);
        resolve({});
      });
    });

    request.on('error', (error) => {
      console.error('Error making Groq API request:', error);
      resolve({});
    });

    request.end();
  });
}

/**
 * Fetches models from the OpenRouter API.
 * @param {string} apiKey OpenRouter API Key
 * @returns {Promise<object>} Object containing model configurations keyed by model ID.
 */
async function fetchOpenRouterModels(apiKey) {
  if (!apiKey) {
    console.log('OpenRouter API key not provided, skipping model fetch.');
    return {};
  }
  console.log('Fetching OpenRouter models...');
    return new Promise((resolve) => {
        const request = net.request({
            method: 'GET',
            protocol: 'https:',
            hostname: 'openrouter.ai',
            path: '/api/v1/models',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });

        let body = '';
        request.on('response', (response) => {
            console.log(`OpenRouter API response status: ${response.statusCode}`);
            response.on('data', (chunk) => {
                body += chunk.toString();
            });
            response.on('end', () => {
                if (response.statusCode === 200) {
                    try {
                        const data = JSON.parse(body);
                        const models = {};
                        if (data && Array.isArray(data.data)) {
                            data.data.forEach(model => {
                                // Map OpenRouter fields
                                //console.log(`[OpenRouter Fetch] Processing model: ${model.id}, Name: ${model.name}`); // Log model ID
                                if (model.architecture) {
                                    //console.log(`  Architecture: ${JSON.stringify(model.architecture)}`); // Log architecture object
                                } else {
                                     //console.log(`  Architecture field missing for ${model.id}`);
                                }
                                
                                // --- Determine vision support reliably ---
                                let vision_supported = false;
                                if (model.architecture && Array.isArray(model.architecture.input_modalities)) {
                                    vision_supported = model.architecture.input_modalities.includes('image');
                                } else {
                                    // Fallback heuristic if architecture info is missing (less reliable)
                                    //console.warn(`Missing architecture.input_modalities for ${model.id}, using fallback heuristic.`);
                                     vision_supported = model.id.includes('vision') || model.id.includes('claude-3') || model.id.includes('gpt-4o'); // Slightly improved fallback
                                }
                                // --- End vision support check ---
                                
                                models[model.id] = {
                                    id: model.id,
                                    name: model.name || model.id, // Use name if available
                                    context: model.context_length || FALLBACK_MODEL_DEFINITIONS['default']?.context || 8192, // Use provided context, default fallback context, or final fallback
                                    vision_supported: vision_supported,
                                    // --- Store Pricing Info (as number per token and original string) ---
                                    prompt_cost_per_token: model.pricing?.prompt ? parseFloat(model.pricing.prompt) : null, // Store numeric cost per token
                                    completion_cost_per_token: model.pricing?.completion ? parseFloat(model.pricing.completion) : null, // Store numeric cost per token
                                    pricing_string_prompt: model.pricing?.prompt, // Keep original string 
                                    pricing_string_completion: model.pricing?.completion, // Keep original string
                                    // --- End Pricing Info ---
                                };
                                
                                // Log pricing info if found
                                // if (model.pricing) {
                                //      console.log(`  Pricing for ${model.id}: ${JSON.stringify(model.pricing)} -> Stored per token: prompt=${models[model.id].prompt_cost_per_token}, completion=${models[model.id].completion_cost_per_token}`);
                                // }
                            });
                        } else {
                            console.warn('OpenRouter API response did not contain expected data structure.', data);
                        }
                        console.log(`Fetched ${Object.keys(models).length} OpenRouter models.`);
                        resolve(models);
                    } catch (error) {
                        console.error('Error parsing OpenRouter models response:', error, 'Body:', body);
                        resolve({});
                    }
                } else {
                    console.error(`Error fetching OpenRouter models: Status ${response.statusCode}`, 'Body:', body);
                    resolve({});
                }
            });
            response.on('error', (error) => {
              console.error('Error during OpenRouter API response:', error);
              resolve({});
            });
        });

        request.on('error', (error) => {
            console.error('Error making OpenRouter API request:', error);
            resolve({});
        });

        request.end();
    });
}

// --- End Model Fetching --- //

// App initialization sequence
app.whenReady().then(async () => {
  console.log("App Ready. Initializing...");

  // --- Task 1: Setup Storage Directory ---
  try {
    if (!fs.existsSync(CHATS_DIR)) {
      fs.mkdirSync(CHATS_DIR, { recursive: true });
      console.log(`Created chats directory at: ${CHATS_DIR}`);
    } else {
      console.log(`Chats directory already exists at: ${CHATS_DIR}`);
    }
  } catch (error) {
    console.error(`Failed to create chats directory at ${CHATS_DIR}:`, error);
    // Consider if this is a fatal error or if the app can continue
  }
  // --- End Task 1 ---

  // Initialize command resolver first (might be needed by others)
  initializeCommandResolver(app);

  // Load model context sizes from the JS module
  // try {
  //   modelContextSizes = MODEL_CONTEXT_SIZES;
  //   console.log('Successfully loaded shared model definitions.');
  // } catch (error) {
  //   console.error('Failed to load shared model definitions:', error);
  //   modelContextSizes = { 'default': { context: 8192, vision_supported: false } }; // Fallback
  // }

  // Initialize window manager and get the main window instance
  mainWindow = initializeWindowManager(app, screen, shell, BrowserWindow);
  if (!mainWindow) {
      console.error("Fatal: Main window could not be created. Exiting.");
      app.quit();
      return;
  }

  // Initialize settings handlers (needs app)
  initializeSettingsHandlers(ipcMain, app);

  // Fetch models after settings are loaded
  const currentSettings = loadSettings(); // Load initial settings
  // Fetch models asynchronously without blocking startup
  fetchGroqModels(currentSettings.groqApiKey)
      .then(models => { platformModels.groq = models; })
      .catch(err => console.error("Error fetching Groq models during init:", err));
  fetchOpenRouterModels(currentSettings.openrouterApiKey)
      .then(models => { platformModels.openrouter = models; })
      .catch(err => console.error("Error fetching OpenRouter models during init:", err));

  // Initialize MCP handlers (needs app, mainWindow, settings/command functions)
  initializeMcpHandlers(ipcMain, app, mainWindow, loadSettings, resolveCommandPath);

  // --- Register Core App IPC Handlers --- //

  // Chat completion with streaming - uses chatHandler
  ipcMain.on('chat-stream', async (event, messages, model) => {
    const currentSettings = loadSettings(); // Get current settings from settingsManager
    const { discoveredTools } = getMcpState(); // Get current tools from mcpManager
    // Pass the selected platform from settings to the handler
    const selectedPlatform = currentSettings.selectedPlatform || 'groq'; // Default to groq if not set
    chatHandler.handleChatStream(event, messages, model, currentSettings, platformModels, discoveredTools, selectedPlatform);
  });

  // Handler for executing tool calls - uses toolHandler
  ipcMain.handle('execute-tool-call', async (event, toolCall) => {
    const { discoveredTools, mcpClients } = getMcpState(); // Get current state from mcpManager
    return toolHandler.handleExecuteToolCall(event, toolCall, discoveredTools, mcpClients);
  });

  // Handler for getting model configurations
  ipcMain.handle('get-model-configs', async (event, platformHint = null) => {
      // Determine which platform's models to return
      let selectedPlatform;
      if (platformHint && (platformHint === 'groq' || platformHint === 'openrouter')) {
          console.log(`get-model-configs: Using provided platform hint: ${platformHint}`);
          selectedPlatform = platformHint;
      } else {
          const currentSettings = loadSettings();
          selectedPlatform = currentSettings.selectedPlatform || 'groq'; // Default to groq if not set
          console.log(`get-model-configs: Using platform from settings: ${selectedPlatform}`);
      }

      const modelsToReturn = platformModels[selectedPlatform] || {};

      // If no models are loaded for the selected platform, try fetching them now
      // (This handles cases where the key might have been added after initial load or if hint is used before initial fetch completes)
      if (Object.keys(modelsToReturn).length === 0) {
          console.log(`No models found for ${selectedPlatform}, attempting fetch...`);
          const currentSettings = loadSettings(); // Need settings again for API keys
          if (selectedPlatform === 'groq' && currentSettings.groqApiKey) {
              platformModels.groq = await fetchGroqModels(currentSettings.groqApiKey);
              return platformModels.groq;
          } else if (selectedPlatform === 'openrouter' && currentSettings.openrouterApiKey) {
              platformModels.openrouter = await fetchOpenRouterModels(currentSettings.openrouterApiKey);
              return platformModels.openrouter;
          } else {
               console.warn(`Cannot fetch models for ${selectedPlatform}: API key might be missing.`);
               return {}; // Return empty if fetch isn't possible
          }
      }

      return modelsToReturn;
  });

  // --- Task 2: List Chats Handler ---
  ipcMain.handle('list-chats', async () => {
    console.log("IPC Handler: list-chats invoked");
    try {
      const files = await fs.promises.readdir(CHATS_DIR);
      const chatFiles = files.filter(file => file.endsWith('.json'));
      const chatsMetadata = [];

      for (const file of chatFiles) {
        const filePath = path.join(CHATS_DIR, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const chatData = JSON.parse(content);
          // Ensure necessary fields exist before adding
          if (chatData.id && chatData.title && chatData.lastModified) {
              chatsMetadata.push({
                  id: chatData.id,
                  title: chatData.title,
                  lastModified: chatData.lastModified,
              });
          } else {
              console.warn(`Skipping chat file due to missing fields: ${file}`);
          }
        } catch (readError) {
          console.error(`Error reading or parsing chat file ${file}:`, readError);
          // Optionally delete corrupted files? Or just skip.
        }
      }

      // Sort by lastModified date, newest first
      chatsMetadata.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
      console.log(`Found ${chatsMetadata.length} chats.`);
      return chatsMetadata;
    } catch (error) {
      console.error('Error listing chats:', error);
      // Check if error is because directory doesn't exist, though we try to create it
      if (error.code === 'ENOENT') {
          console.log('Chats directory not found while listing - it might need to be created.');
          return []; // Return empty list if dir doesn't exist
      }
      return []; // Return empty list on other errors for now
    }
  });
  // --- End Task 2 ---

  // --- Task 3: Save Chat Handler ---
  ipcMain.handle('save-chat', async (event, chatData) => {
    console.log(`IPC Handler: save-chat invoked for ID: ${chatData?.id || 'new'}`);
    // Validate required fields from frontend (messages, platform, model)
    if (!chatData || typeof chatData !== 'object' || !chatData.messages || !chatData.platform || !chatData.model) {
        console.error("save-chat: Invalid chatData received. Missing messages, platform, or model.", chatData);
        return { success: false, error: "Invalid chat data received (missing required fields)" };
    }

    const chatId = chatData.id || uuidv4(); // Use existing ID or generate a new one
    const chatFilePath = path.join(CHATS_DIR, `${chatId}.json`);
    const now = new Date().toISOString();

    const dataToSave = {
        // Spread all properties sent from frontend, ensuring we capture platform/model
        ...chatData,
        id: chatId, // Ensure the ID is set/updated
        lastModified: now,
        createdAt: chatData.createdAt || now, // Set createdAt only if it doesn't exist
        // Explicitly ensure platform and model are saved (though covered by spread)
        platform: chatData.platform,
        model: chatData.model
    };

    // Basic title generation if missing (can be improved later)
    if (!dataToSave.title) {
        const firstUserMessage = dataToSave.messages.find(m => m.role === 'user')?.content;
        if (typeof firstUserMessage === 'string' && firstUserMessage.trim()) {
            dataToSave.title = firstUserMessage.substring(0, 50) + (firstUserMessage.length > 50 ? '...' : '');
        } else {
            dataToSave.title = `Chat ${new Date(dataToSave.createdAt).toLocaleString()}`; // Fallback title
        }
        console.log(`Generated title for chat ${chatId}: ${dataToSave.title}`);
    }

    try {
      await fs.promises.writeFile(chatFilePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      console.log(`Chat saved successfully: ${chatFilePath}`);
      // Return the potentially updated/new data (especially title/id/timestamps)
      return { success: true, savedChatData: dataToSave };
    } catch (error) {
      console.error(`Error saving chat ${chatId}:`, error);
      return { success: false, error: error.message };
    }
  });
  // --- End Task 3 ---

  // --- Task 4: Load Chat Handler ---
  ipcMain.handle('load-chat', async (event, chatId) => {
    console.log(`IPC Handler: load-chat invoked for ID: ${chatId}`);
    if (!chatId) {
        console.error("load-chat: No chatId provided.");
        return { success: false, error: "No chat ID provided" };
    }
    const chatFilePath = path.join(CHATS_DIR, `${chatId}.json`);

    try {
      const content = await fs.promises.readFile(chatFilePath, 'utf-8');
      const chatData = JSON.parse(content);
      console.log(`Chat loaded successfully: ${chatFilePath}`);
      return { success: true, chatData: chatData };
    } catch (error) {
      console.error(`Error loading chat ${chatId}:`, error);
       if (error.code === 'ENOENT') {
           return { success: false, error: `Chat file not found for ID: ${chatId}` };
       } else if (error instanceof SyntaxError) {
            return { success: false, error: `Failed to parse chat file for ID: ${chatId}` };
       } else {
           return { success: false, error: error.message };
       }
    }
  });
  // --- End Task 4 ---

  // --- Task 5: Delete Chat Handler ---
  ipcMain.handle('delete-chat', async (event, chatId) => {
    console.log(`IPC Handler: delete-chat invoked for ID: ${chatId}`);
    if (!chatId) {
        console.error("delete-chat: No chatId provided.");
        return { success: false, error: "No chat ID provided" };
    }
    const chatFilePath = path.join(CHATS_DIR, `${chatId}.json`);

    try {
      await fs.promises.unlink(chatFilePath);
      console.log(`Chat deleted successfully: ${chatFilePath}`);
      return { success: true };
    } catch (error) {
      console.error(`Error deleting chat ${chatId}:`, error);
      if (error.code === 'ENOENT') {
          console.warn(`Attempted to delete non-existent chat file: ${chatFilePath}`);
          // Consider returning success true here as the end state (file gone) is achieved
          return { success: true };
      }
      return { success: false, error: error.message };
    }
  });
  // --- End Task 5 ---

  // --- Phase 4: Rename Chat Handler ---
  ipcMain.handle('update-chat-metadata', async (event, chatId, metadataUpdate) => {
    console.log(`IPC Handler: update-chat-metadata invoked for ID: ${chatId}`);
    if (!chatId || !metadataUpdate || typeof metadataUpdate !== 'object') {
      console.error("update-chat-metadata: Invalid arguments received.");
      return { success: false, error: "Invalid arguments for updating chat metadata" };
    }

    const chatFilePath = path.join(CHATS_DIR, `${chatId}.json`);

    try {
      // Read existing data
      const content = await fs.promises.readFile(chatFilePath, 'utf-8');
      let chatData = JSON.parse(content);

      // Apply updates (only title for now)
      let updated = false;
      if (metadataUpdate.hasOwnProperty('title') && typeof metadataUpdate.title === 'string') {
          if (chatData.title !== metadataUpdate.title) {
             chatData.title = metadataUpdate.title.trim() || `Chat ${new Date(chatData.createdAt).toLocaleString()}`; // Ensure title is not empty
             updated = true;
             console.log(`Updating title for chat ${chatId} to: "${chatData.title}"`);
          } else {
             console.log(`Title for chat ${chatId} is already "${metadataUpdate.title}", no update needed.`);
          }
      }
      // Add other metadata updates here if needed in the future

      if (!updated) {
          console.log(`No actual metadata changes for chat ${chatId}. Skipping write.`);
          // Return success, but indicate no change occurred?
          // Return existing data to be safe
          return { success: true, updatedChatData: chatData, needsRefresh: false };
      }

      // Update lastModified timestamp
      chatData.lastModified = new Date().toISOString();

      // Write updated data back
      await fs.promises.writeFile(chatFilePath, JSON.stringify(chatData, null, 2), 'utf-8');
      console.log(`Chat metadata updated successfully: ${chatFilePath}`);
      // Return the full updated data
      return { success: true, updatedChatData: chatData, needsRefresh: true };

    } catch (error) {
      console.error(`Error updating metadata for chat ${chatId}:`, error);
      if (error.code === 'ENOENT') {
        return { success: false, error: `Chat file not found for ID: ${chatId}` };
      } else if (error instanceof SyntaxError) {
        return { success: false, error: `Failed to parse chat file for ID: ${chatId}` };
      } else {
        return { success: false, error: error.message };
      }
    }
  });
  // --- End Rename Chat Handler ---

  // --- File Extraction Handler ---
  ipcMain.on('request-file-extraction', async (event, filePath, uniqueId) => {
      console.log(`[IPC Main] Received request-file-extraction for ID: ${uniqueId}, Path: ${filePath}`);
      if (!filePath || !uniqueId) {
          console.error("[IPC Main] Invalid request-file-extraction: Missing filePath or uniqueId.");
          // Send error back immediately?
          event.sender.send('file-extraction-status', { uniqueId, status: 'error', error: 'Invalid request data.' });
          return;
      }

      // Send initial 'extracting' status
      event.sender.send('file-extraction-status', { uniqueId, status: 'extracting' });

      try {
          // TODO: Add file path validation here for security
          // e.g., check if path is within expected directories

          const extractedText = await extractTextFromFile(filePath);
          console.log(`[IPC Main] Extraction complete for ID: ${uniqueId}`);
          event.sender.send('file-extraction-status', { 
              uniqueId, 
              status: 'complete', 
              result: extractedText 
          });
      } catch (error) {
          console.error(`[IPC Main] Extraction failed for ID: ${uniqueId}`, error);
          event.sender.send('file-extraction-status', { 
              uniqueId, 
              status: 'error', 
              error: error.message || 'Unknown extraction error' 
          });
      }
  });
  // --- End File Extraction Handler ---

  // --- Post-initialization Tasks --- //

  // Attempt to connect to configured MCP servers after setup
  // Wrap in a small timeout to ensure renderer is likely ready for status updates
  setTimeout(() => {
      connectConfiguredMcpServers(); // Call the function from mcpManager
  }, 1000); // 1 second delay

  console.log("Initialization complete.");
});

// Note: App lifecycle events (window-all-closed, activate) are now handled by windowManager.js

// Keep any essential top-level error handling or logging if needed
process.on('uncaughtException', (error) => {
    console.error('Unhandled Exception:', error);
    // Optionally: Log to file, show dialog, etc.
});