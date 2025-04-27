const fs = require('fs');
const path = require('path');
const { URL } = require('url'); // Import URL
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

// State variables managed by this module
let mcpClients = {};
let discoveredTools = [];
const mcpServerLogs = {};
const MAX_LOG_LINES = 500; // Limit stored log lines per server

// Dependencies injected during initialization
// let _ipcMainInstance; // Removed unused variable
let appInstance;
let mainWindowInstance;
let loadSettingsFunc;
let resolveCommandPathFunc;

// Notify renderer process about MCP server status changes
function notifyMcpServerStatus() {
  if (mainWindowInstance && !mainWindowInstance.isDestroyed() && mainWindowInstance.webContents) {
    mainWindowInstance.webContents.send('mcp-server-status-changed', {
      tools: [...discoveredTools], // Send a copy
      connectedServers: Object.keys(mcpClients)
    });
     console.log('Notified renderer of MCP status change.');
  } else {
      console.warn('Cannot notify renderer: mainWindow not available or destroyed.');
  }
}

// Function to send log updates to the renderer
function sendLogUpdate(serverId, logChunk) {
    if (mainWindowInstance && !mainWindowInstance.isDestroyed() && mainWindowInstance.webContents) {
        mainWindowInstance.webContents.send('mcp-log-update', { serverId, logChunk });
    }
}

// Function to set up periodic health check for a server
function setupServerHealthCheck(client, serverId, intervalMs) {
  // Clear existing interval for this client if any (safety measure)
  if (client.healthCheckInterval) {
    clearInterval(client.healthCheckInterval);
    console.log(`[${serverId}] Cleared previous health check interval.`);
  }

  console.log(`[${serverId}] Setting up health check interval: ${intervalMs}ms`);

  client.healthCheckInterval = setInterval(async () => {
    console.log(`[${serverId}] Performing health check...`);
    try {
      // Use a lightweight operation like listTools for health check
      // Add a timeout specific to the health check itself
       const healthCheckTimeout = 600000; // 10 minute timeout for health check probe
       await Promise.race([
            client.listTools(), // Or potentially a dedicated health check endpoint if MCP SDK adds one
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Health check timed out after ${healthCheckTimeout}ms`)), healthCheckTimeout)
            )
        ]);
      // If listTools succeeds, server is considered healthy
      console.log(`[${serverId}] Health check successful.`);
    } catch (error) {
      console.error(`[${serverId}] Health check failed:`, error.message || error);

      // --- Recovery / Disconnect Logic ---
      clearInterval(client.healthCheckInterval); // Stop trying on this interval
      client.healthCheckInterval = null; // Clear the stored interval ID

      console.warn(`[${serverId}] Health check failed. Marking as disconnected and cleaning up.`);

      // Clean up the failed client connection
       if (mcpClients[serverId] === client) { // Ensure we're removing the correct client instance
           delete mcpClients[serverId];
           // Remove tools associated with this server
           discoveredTools = discoveredTools.filter(t => t.serverId !== serverId);
           // Clear logs for the failed server
           delete mcpServerLogs[serverId];
           // Notify renderer about the disconnection due to health check failure
           notifyMcpServerStatus();

           // Attempt to close the client connection gracefully, but don't wait indefinitely
           try {
               await client.close();
               console.log(`[${serverId}] Closed client connection after health check failure.`);
           } catch (closeError) {
               console.error(`[${serverId}] Error closing client after health check failure: ${closeError.message}`);
           }
       } else {
           console.warn(`[${serverId}] Client instance mismatch during health check failure cleanup. State might be inconsistent.`);
       }
    }
  }, intervalMs);
}

// Function to connect to an MCP server using process configuration
async function connectMcpServerProcess(serverId, connectionDetails) {
    // --- Pre-connection Cleanup ---
    if (mcpClients[serverId]) {
        console.log(`[${serverId}] Cleaning up existing client/connection before new attempt.`);
        const oldClient = mcpClients[serverId];
        if (oldClient.healthCheckInterval) clearInterval(oldClient.healthCheckInterval);
        if (oldClient.transport instanceof StdioClientTransport && oldClient.transport?.process?.stderr) {
            oldClient.transport.process.stderr.removeAllListeners();
        }
        try { await oldClient.close(); } catch (e) { console.warn(`Error closing previous client ${serverId}: ${e.message}`); }
        delete mcpClients[serverId];
        discoveredTools = discoveredTools.filter(t => t.serverId !== serverId);
        delete mcpServerLogs[serverId];
        notifyMcpServerStatus(); // Notify UI about cleanup
    }

    // --- Validate Config ---
    const transportType = connectionDetails.transport || 'stdio';
    if (transportType === 'stdio' && !connectionDetails.command) throw new Error(`[${serverId}] Internal Error: Missing command for stdio.`);
    if (transportType === 'sse' && !connectionDetails.url) throw new Error(`[${serverId}] Internal Error: Missing url for sse.`);

    // --- Determine Server Type & Timeouts ---
    let connectTimeout = 5000;
    if (transportType === 'stdio') {
        const resolvedCommandBase = path.basename(connectionDetails.command);
        const isUvx = resolvedCommandBase === 'uvx';
        const isPython = resolvedCommandBase === 'python' || resolvedCommandBase === 'python3';
        connectTimeout = isUvx ? 10000 : (isPython ? 5000 : 3000);
    } else { connectTimeout = 10000; }
    const listToolsTimeout = 15000;
    const healthCheckIntervalMs = 60000;

    console.log(`Attempting ${transportType.toUpperCase()} connection to ${serverId}${transportType === 'stdio' ? ` cmd: ${connectionDetails.command}` : ` url: ${connectionDetails.url}`} (Conn T/O: ${connectTimeout}ms)`);

    // --- Create Client and Transport ---
    const client = new Client({ name: "groq-desktop", version: appInstance.getVersion(), capabilities: { tools: true } });
    let transport;
    try {
        if (transportType === 'sse') {
            const sseUrl = new URL(connectionDetails.url);
            transport = new SSEClientTransport(sseUrl, {});
        } else { // stdio
            // Construct the PATH needed by the script
            const requiredPaths = [
                '/usr/local/bin',
                '/usr/bin',
                '/bin',
                '/usr/sbin',
                '/sbin',
                process.env.HOME ? `${process.env.HOME}/.deno/bin` : null, // Deno install path
                '/opt/homebrew/bin' // Homebrew on Apple Silicon
            ].filter(Boolean); // Remove nulls if HOME isn't set

            const baseEnvPath = process.env.PATH || '';
            const customEnvPath = connectionDetails.env?.PATH || '';
            const combinedPath = [
                ...requiredPaths,
                ...baseEnvPath.split(':'),
                ...customEnvPath.split(':')
            ].filter((p, i, arr) => p && arr.indexOf(p) === i).join(':'); // Deduplicate and join

            const finalEnv = {
                 ...process.env, // Base environment
                 ...connectionDetails.env, // Custom env from config
                 PATH: combinedPath // Override with the combined PATH
            };

            const transportOptions = {
                command: connectionDetails.command,
                args: connectionDetails.args || [],
                env: finalEnv,
                cwd: path.dirname(connectionDetails.command), // Set cwd to script's directory
                connectTimeout: connectTimeout,
                stderr: 'pipe'
            };
            transport = new StdioClientTransport(transportOptions);
        }
    } catch (transportError) {
         console.error(`[${serverId}] Error creating transport: ${transportError.message}`);
         throw transportError;
    }

    mcpServerLogs[serverId] = []; // Initialize log buffer

    // --- Connection and Initialization Logic ---
    try {
        console.log(`[${serverId}] Connecting transport...`);
        await client.connect(transport);
        mcpClients[serverId] = client; // Store client
        console.log(`[${serverId}] Transport connected.`);

        // --- Stderr Logging & Process Exit/Error Handling ---
        if (transport instanceof StdioClientTransport && transport.stderr) {
            console.log(`[${serverId}] Attaching stderr listener.`);
            transport.stderr.setEncoding('utf8');
            const handleStderrData = (data) => {
                const lines = data.toString().split('\n').filter(line => line.trim() !== '');
                if (lines.length > 0) {
                    mcpServerLogs[serverId] = [...mcpServerLogs[serverId], ...lines].slice(-MAX_LOG_LINES);
                    sendLogUpdate(serverId, lines.join('\n'));
                }
            };
            const handleStderrError = (err) => {
                console.error(`[${serverId}] Error reading stderr:`, err);
                const errorLine = `[stderr error: ${err.message}]`;
                mcpServerLogs[serverId] = [...(mcpServerLogs[serverId] || []), errorLine].slice(-MAX_LOG_LINES);
                sendLogUpdate(serverId, errorLine);
            };
            const handleStderrEnd = () => {
                console.log(`[${serverId}] stderr stream ended.`);
                const endLine = "[stderr stream closed]";
                mcpServerLogs[serverId] = [...(mcpServerLogs[serverId] || []), endLine].slice(-MAX_LOG_LINES);
                sendLogUpdate(serverId, endLine);
                 // Remove listeners on end to prevent leaks if process lingers?
                transport.stderr?.removeListener('data', handleStderrData);
                transport.stderr?.removeListener('error', handleStderrError);
                transport.stderr?.removeListener('end', handleStderrEnd);
            };
            transport.stderr.on('data', handleStderrData);
            transport.stderr.on('error', handleStderrError);
            transport.stderr.on('end', handleStderrEnd);
        } else if (transportType === 'stdio') {
            console.warn(`[${serverId}] Could not attach stderr listener.`);
            const warnLine = "[stderr stream not available]";
            mcpServerLogs[serverId] = [...(mcpServerLogs[serverId] || []), warnLine].slice(-MAX_LOG_LINES);
            sendLogUpdate(serverId, warnLine);
        }

        console.log(`[${serverId}] Listing tools (T/O: ${listToolsTimeout}ms)...`);
        // --- List Tools with Timeout ---
        const toolsResult = await Promise.race([
            client.listTools(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`listTools timed out`)), listToolsTimeout))
        ]);

        // --- Process Tools ---
        let serverTools = [];
        if (toolsResult && toolsResult.tools && Array.isArray(toolsResult.tools)) {
             serverTools = toolsResult.tools.map(tool => ({
                name: tool.name || 'unnamed_tool',
                description: tool.description || 'No description',
                input_schema: tool.inputSchema || {},
                serverId: serverId
            }));
            console.log(`[${serverId}] Discovered ${serverTools.length} tools.`);
        } else {
            console.warn(`[${serverId}] listTools returned no tools or invalid format.`);
        }

        // --- Update Global State and Notify ---
        discoveredTools = [...discoveredTools, ...serverTools];
        setupServerHealthCheck(client, serverId, healthCheckIntervalMs);
        notifyMcpServerStatus();

        return { success: true, tools: serverTools };

    } catch (error) {
        console.error(`[${serverId}] Failed to connect or initialize:`, error.message || error);
        // --- Error Handling and Cleanup ---
        if (mcpClients[serverId]) {
            if (mcpClients[serverId].healthCheckInterval) clearInterval(mcpClients[serverId].healthCheckInterval);
            try { await mcpClients[serverId].close(); } catch (e) { console.error(`[${serverId}] Error closing client on failure: ${e.message}`); }
            delete mcpClients[serverId];
        }
        if (transport instanceof StdioClientTransport && transport.stderr) {
             transport.stderr.removeAllListeners();
        }
        discoveredTools = discoveredTools.filter(t => t.serverId !== serverId);
        delete mcpServerLogs[serverId];
        notifyMcpServerStatus();
        throw error; // Re-throw
    }
}

// Function to connect to all configured MCP servers from settings
async function connectConfiguredMcpServers() {
    if (!loadSettingsFunc || !resolveCommandPathFunc) {
        console.error("MCP Manager not fully initialized. Cannot connect configured servers.");
        return;
    }
  try {
    const settings = loadSettingsFunc();

    if (!settings.mcpServers || Object.keys(settings.mcpServers).length === 0) {
      console.log('No MCP servers configured, skipping auto-connections.');
      return;
    }

    const disabledServers = settings.disabledMcpServers || [];
    const serverConfigs = Object.entries(settings.mcpServers)
                                .filter(([serverId]) => !disabledServers.includes(serverId));

    const totalCount = Object.keys(settings.mcpServers).length;
    const disabledCount = disabledServers.length;
    const enabledCount = serverConfigs.length;

    console.log(`Found ${totalCount} MCP servers. Connecting to ${enabledCount} enabled (${disabledCount} disabled)...`);
    if (enabledCount === 0) return;

    let successCount = 0;
    let failCount = 0;

    const connectionPromises = serverConfigs.map(async ([serverId, serverConfig]) => {
      try {
        const transportType = serverConfig.transport === 'sse' ? 'sse' : 'stdio';
        let connectionDetails = { transport: transportType };

        if (transportType === 'sse') {
            if (!serverConfig.url) throw new Error(`Missing 'url' for SSE server ${serverId}.`);
            try { new URL(serverConfig.url); connectionDetails.url = serverConfig.url; } catch (e) { throw new Error(`Invalid 'url' for SSE ${serverId}: ${e.message}`); }
        } else { // stdio
            if (!serverConfig.command) throw new Error(`Missing 'command' for stdio server ${serverId}.`);
            connectionDetails.command = resolveCommandPathFunc(serverConfig.command);
            connectionDetails.args = serverConfig.args || [];
            connectionDetails.env = serverConfig.env || {};
        }

        await connectMcpServerProcess(serverId, connectionDetails);
        console.log(`Successfully connected to MCP server: ${serverId}`);
        return { status: 'fulfilled', serverId };
      } catch (error) {
        console.error(`Failed auto-connect ${serverId}:`, error.message || error);
        return { status: 'rejected', serverId, reason: error.message || error };
      }
    });

    const results = await Promise.allSettled(connectionPromises);
    results.forEach(result => {
        if (result.status === 'fulfilled') successCount++;
        else failCount++;
    });
    console.log(`MCP auto-connection summary: ${successCount} succeeded, ${failCount} failed.`);

  } catch (error) {
    console.error('Error during connectConfiguredMcpServers:', error);
  }
}

function initializeMcpHandlers(ipcMain, app, mainWindow, loadSettings, resolveCommandPath) {
    // _ipcMainInstance = ipcMain; // Removed assignment to unused variable
    appInstance = app;
    mainWindowInstance = mainWindow;
    loadSettingsFunc = loadSettings;
    resolveCommandPathFunc = resolveCommandPath;

    console.log("MCPManager Initialized.");

    // Handler for connecting to an MCP server
    ipcMain.handle('connect-mcp-server', async (event, serverConfig) => {
      if (!serverConfig || !serverConfig.id ||
          (serverConfig.transport === 'sse' && !serverConfig.url) ||
          (serverConfig.transport !== 'sse' && !serverConfig.command && !serverConfig.scriptPath)) {
          console.error("Invalid serverConfig for connect-mcp-server:", serverConfig);
          return { success: false, error: "Invalid server configuration.", tools: [], allTools: discoveredTools };
      }

      try {
        const { id, scriptPath, command, args, env, transport, url } = serverConfig;
        const settings = loadSettingsFunc();
        if (settings.disabledMcpServers?.includes(id)) {
            settings.disabledMcpServers = settings.disabledMcpServers.filter(serverId => serverId !== id);
            const userDataPath = appInstance.getPath('userData');
            const settingsPath = path.join(userDataPath, 'settings.json');
            try {
                fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
                console.log(`Removed ${id} from disabled list.`);
            } catch (saveError) { console.error(`Failed to save settings after enabling ${id}:`, saveError); }
        }

        let connectionDetails = { transport: transport || 'stdio' };

        if (connectionDetails.transport === 'sse') {
            if (!url) return { success: false, error: `Missing 'url' for SSE server ${id}`, tools: [], allTools: discoveredTools };
            try { new URL(url); connectionDetails.url = url; } catch (e) { return { success: false, error: `Invalid 'url' for SSE ${id}: ${e.message}`, tools: [], allTools: discoveredTools }; }
        } else { // stdio
            if (command) {
                const resolvedCommand = resolveCommandPathFunc(command);
                connectionDetails.command = resolvedCommand;
                connectionDetails.args = args || [];
                connectionDetails.env = env || {};
            } else if (scriptPath) { // Handle legacy scriptPath if needed
                const absoluteScriptPath = path.resolve(scriptPath);
                if (!fs.existsSync(absoluteScriptPath)) return { success: false, error: `Script not found: ${absoluteScriptPath}`, tools: [], allTools: discoveredTools };
                const isJs = absoluteScriptPath.endsWith('.js');
                const isPy = absoluteScriptPath.endsWith('.py');
                if (!isJs && !isPy) return { success: false, error: "Script must be .js or .py", tools: [], allTools: discoveredTools };
                const scriptCommand = isPy ? (process.platform === "win32" ? "python" : "python3") : process.execPath;
                connectionDetails.command = scriptCommand;
                connectionDetails.args = [absoluteScriptPath, ...(args || [])];
                connectionDetails.env = env || {};
                console.log(`Using script path for ${id}: ${scriptCommand} ${absoluteScriptPath}`);
            } else {
                return { success: false, error: `Internal Error: No command/scriptPath for stdio ${id}.`, tools: [], allTools: discoveredTools };
            }
        }

        const result = await connectMcpServerProcess(id, connectionDetails);
        return { success: true, tools: result.tools || [], allTools: discoveredTools };

      } catch (error) {
        console.error(`Error connecting MCP server (${serverConfig?.id || '?'}):`, error);
        return { success: false, error: error.message || "Connection error.", tools: [], allTools: discoveredTools };
      }
    });

    // Handler for disconnecting from an MCP server
    ipcMain.handle('disconnect-mcp-server', async (event, serverId) => {
        if (!serverId || typeof serverId !== 'string') {
            console.error("Invalid serverId for disconnect:", serverId);
            return { success: false, error: "Invalid Server ID.", allTools: discoveredTools };
        }

        try {
            const settings = loadSettingsFunc();
            if (!settings.disabledMcpServers) settings.disabledMcpServers = [];
            if (!settings.disabledMcpServers.includes(serverId)) {
                settings.disabledMcpServers.push(serverId);
                const userDataPath = appInstance.getPath('userData');
                const settingsPath = path.join(userDataPath, 'settings.json');
                try {
                    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
                    console.log(`Added ${serverId} to disabled list.`);
                } catch (saveError) { console.error(`Failed to save settings after disabling ${serverId}:`, saveError); }
            }

            if (mcpClients[serverId]) {
                const client = mcpClients[serverId];
                if (client.healthCheckInterval) clearInterval(client.healthCheckInterval);
                try { await client.close(); console.log(`Closed connection to ${serverId}`); } catch(e) { console.error(`Error closing client ${serverId}:`, e); }
                delete mcpClients[serverId];
                const initialToolCount = discoveredTools.length;
                discoveredTools = discoveredTools.filter(t => t.serverId !== serverId);
                console.log(`Removed ${initialToolCount - discoveredTools.length} tools for ${serverId}`);
                delete mcpServerLogs[serverId]; // Clear logs on disconnect
                notifyMcpServerStatus();
                return { success: true, allTools: discoveredTools };
            } else {
                console.log(`No active client found for ${serverId} to disconnect.`);
                discoveredTools = discoveredTools.filter(t => t.serverId !== serverId);
                delete mcpServerLogs[serverId]; // Ensure logs are cleared even if client was lost
                notifyMcpServerStatus();
                return { success: true, message: "No active client found.", allTools: discoveredTools };
            }
        } catch (error) {
            console.error(`Error disconnecting ${serverId}:`, error);
            return { success: false, error: error.message || "Disconnection error.", allTools: discoveredTools };
        }
    });

    // Handler for getting all discovered tools
    ipcMain.handle('get-mcp-tools', async () => {
      return { tools: [...discoveredTools] }; // Return a copy
    });

    // Handler for getting MCP server logs
    ipcMain.handle('get-mcp-server-logs', async (event, serverId) => {
        if (!serverId || typeof serverId !== 'string') {
            console.error("Invalid serverId for get-logs:", serverId);
            return { logs: ["[Error: Invalid Server ID]"] };
        }
        const logs = mcpServerLogs[serverId] ? [...mcpServerLogs[serverId]] : [];
        console.log(`Retrieved ${logs.length} logs for ${serverId}`);
        return { logs };
    });
}

// Function to get current state (needed by main.js for other handlers)
function getMcpState() {
    return {
        mcpClients,
        discoveredTools
    };
}

module.exports = {
    initializeMcpHandlers,
    connectConfiguredMcpServers,
    getMcpState // Export getter for state
    // Expose connectMcpServerProcess or others only if absolutely necessary outside this module
}; 