const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

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
const { BrowserWindow, ipcMain, screen, shell, net } = require('electron');

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
                                // Map OpenRouter fields (assuming structure from Gist)
                                // Determine vision support (needs a heuristic or assumption)
                                const vision_supported = model.id.includes('vision') || model.id.includes('claude-3'); // Basic heuristic
                                models[model.id] = {
                                    id: model.id,
                                    name: model.name || model.id, // Use name if available
                                    context: model.context_length || FALLBACK_MODEL_DEFINITIONS['default'].context, // Use provided context length or fallback
                                    vision_supported: vision_supported,
                                    // Add other fields like pricing if needed later
                                };
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
    chatHandler.handleChatStream(event, messages, model, currentSettings, platformModels, discoveredTools);
  });

  // Handler for executing tool calls - uses toolHandler
  ipcMain.handle('execute-tool-call', async (event, toolCall) => {
    const { discoveredTools, mcpClients } = getMcpState(); // Get current state from mcpManager
    return toolHandler.handleExecuteToolCall(event, toolCall, discoveredTools, mcpClients);
  });

  // Handler for getting model configurations
  ipcMain.handle('get-model-configs', async () => {
      // Return models for the currently selected platform
      const currentSettings = loadSettings();
      const selectedPlatform = currentSettings.selectedPlatform || 'groq'; // Default to groq
      const modelsToReturn = platformModels[selectedPlatform] || {};

      // If no models are loaded for the selected platform, try fetching them now
      // (This handles cases where the key might have been added after initial load)
      if (Object.keys(modelsToReturn).length === 0) {
          console.log(`No models found for ${selectedPlatform}, attempting fetch...`);
          if (selectedPlatform === 'groq' && currentSettings.groqApiKey) {
              platformModels.groq = await fetchGroqModels(currentSettings.groqApiKey);
              return platformModels.groq;
          } else if (selectedPlatform === 'openrouter' && currentSettings.openrouterApiKey) {
              platformModels.openrouter = await fetchOpenRouterModels(currentSettings.openrouterApiKey);
              return platformModels.openrouter;
          }
      }

      return modelsToReturn;
  });

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