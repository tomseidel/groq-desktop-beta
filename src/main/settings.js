const path = require('path');
const fs = require('fs').promises;
const { app, ipcMain } = require('electron');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'groq-desktop-settings.json');

// Default settings structure
const defaultSettings = {
    groqApiKey: '',
    openrouterApiKey: '', // Add OpenRouter key
    selectedPlatform: 'groq', // Add platform selection ('groq' or 'openrouter')
    model: '', // Keep default model, potentially per-platform later
    max_tokens: 4096, // Add max_tokens setting
    temperature: 0.7,
    top_p: 0.95,
    mcpServers: {},
    disabledMcpServers: [], // Explicitly add from previous edits if needed
    customSystemPrompt: '', // Explicitly add from previous edits if needed
    // Add any other default settings here
};

let settings = { ...defaultSettings };

// Function to load settings from file
async function loadSettings() {
    try {
        await fs.access(SETTINGS_FILE);
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults to ensure all keys exist
        settings = { ...defaultSettings, ...loadedSettings };
        console.log('Settings loaded successfully from:', SETTINGS_FILE);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Settings file not found, using default settings.');
            // Save default settings if file doesn't exist
            await saveSettingsToFile(defaultSettings);
        } else {
            console.error('Failed to load settings:', error);
            // Fallback to defaults in case of other errors (e.g., corrupt file)
            settings = { ...defaultSettings };
        }
    }
    return settings; // Return the loaded/default settings
}

// Function to save settings to file
async function saveSettingsToFile(newSettings) {
    try {
        // Ensure we only save known keys (prevent accidental extra data)
        const settingsToSave = {};
        for (const key in defaultSettings) {
            if (newSettings.hasOwnProperty(key)) {
                settingsToSave[key] = newSettings[key];
            }
        }
        // Update the in-memory settings object
        settings = { ...settings, ...settingsToSave }; // Merge updates into current settings
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(settingsToSave, null, 2), 'utf8');
        console.log('Settings saved successfully to:', SETTINGS_FILE);
        return { success: true };
    } catch (error) {
        console.error('Failed to save settings:', error);
        return { success: false, error: error.message };
    }
}

// Initialize settings on app start
// loadSettings(); // Load settings when the module is initialized

// IPC Handlers
function setupSettingsHandlers() {
    // Handler to get current settings
    ipcMain.handle('get-settings', async () => {
        // Ensure settings are loaded before returning
        await loadSettings(); // Reload from disk in case they were changed externally?
        return settings;
    });

    // Handler to save settings
    ipcMain.handle('save-settings', async (event, newSettings) => {
        return await saveSettingsToFile(newSettings);
    });

    // Initial load when handlers are set up
    loadSettings();
}

module.exports = {
    loadSettings,
    // saveSettings: saveSettingsToFile, // Keep internal
    getSettings: () => settings, // Synchronous getter for internal use if needed
    setupSettingsHandlers
}; 