const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path'),
  reloadSettings: () => ipcRenderer.invoke('reload-settings'),
  // Chat API - streaming only
  executeToolCall: (toolCall) => ipcRenderer.invoke('execute-tool-call', toolCall),
  
  // Streaming API events
  startChatStream: (messages, model, chatId, cachedSummary) => {
    // Start a new chat stream
    ipcRenderer.send('chat-stream', messages, model, chatId, cachedSummary);
    
    // Setup event listeners for streaming responses
    return {
      onStart: (callback) => {
        ipcRenderer.on('chat-stream-start', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('chat-stream-start', callback);
      },
      onContent: (callback) => {
        ipcRenderer.on('chat-stream-content', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('chat-stream-content', callback);
      },
      onToolCalls: (callback) => {
        ipcRenderer.on('chat-stream-tool-calls', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('chat-stream-tool-calls', callback);
      },
      // Add listeners for tool execution steps
      onToolCallStart: (callback) => {
        ipcRenderer.on('tool-call-start', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('tool-call-start', callback);
      },
      onToolCallEnd: (callback) => {
        ipcRenderer.on('tool-call-end', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('tool-call-end', callback);
      },
      // Add listener for final stream start (after tool calls)
      onFinalStart: (callback) => {
         ipcRenderer.on('chat-stream-final-start', (_, data) => callback(data));
         return () => ipcRenderer.removeListener('chat-stream-final-start', callback);
      },
      onComplete: (callback) => {
        ipcRenderer.on('chat-stream-complete', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('chat-stream-complete', callback);
      },
      onError: (callback) => {
        ipcRenderer.on('chat-stream-error', (_, data) => callback(data));
        return () => ipcRenderer.removeListener('chat-stream-error', callback);
      },
      cleanup: () => {
        ipcRenderer.removeAllListeners('chat-stream-start');
        ipcRenderer.removeAllListeners('chat-stream-content');
        ipcRenderer.removeAllListeners('chat-stream-tool-calls');
        // Add new listeners to cleanup
        ipcRenderer.removeAllListeners('tool-call-start');
        ipcRenderer.removeAllListeners('tool-call-end');
        ipcRenderer.removeAllListeners('chat-stream-final-start');
        // Existing cleanup
        ipcRenderer.removeAllListeners('chat-stream-complete');
        ipcRenderer.removeAllListeners('chat-stream-error');
      }
    };
  },
  
  // MCP related functions
  connectMcpServer: (serverConfig) => ipcRenderer.invoke('connect-mcp-server', serverConfig),
  disconnectMcpServer: (serverId) => ipcRenderer.invoke('disconnect-mcp-server', serverId),
  getMcpTools: () => ipcRenderer.invoke('get-mcp-tools'),
  // Function to get model configurations
  getModelConfigs: () => ipcRenderer.invoke('get-model-configs'),
  
  // --- Chat Persistence Functions ---
  listChats: () => ipcRenderer.invoke('list-chats'),
  saveChat: (chatData) => ipcRenderer.invoke('save-chat', chatData),
  loadChat: (chatId) => ipcRenderer.invoke('load-chat', chatId),
  deleteChat: (chatId) => ipcRenderer.invoke('delete-chat', chatId),
  updateChatMetadata: (chatId, metadataUpdate) => ipcRenderer.invoke('update-chat-metadata', chatId, metadataUpdate),
  // --- End Chat Persistence ---
  
  // Add event listener for MCP server status changes
  onMcpServerStatusChanged: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('mcp-server-status-changed', listener);
    // Return a function to remove the listener
    return () => ipcRenderer.removeListener('mcp-server-status-changed', listener);
  },
  
  // MCP Log Handling
  getMcpServerLogs: (serverId) => ipcRenderer.invoke('get-mcp-server-logs', serverId),
  onMcpLogUpdate: (callback) => {
    const listener = (event, { serverId, logChunk }) => callback(serverId, logChunk);
    ipcRenderer.on('mcp-log-update', listener);
    // Return a function to remove the listener
    return () => ipcRenderer.removeListener('mcp-log-update', listener);
  },
  
  // --- File Extraction IPC --- 
  requestFileExtraction: (filePath, uniqueId) => {
      console.log(`[Preload] Sending request-file-extraction for ID: ${uniqueId}, Path: ${filePath}`);
      ipcRenderer.send('request-file-extraction', filePath, uniqueId);
  },
  onFileExtractionStatus: (callback) => {
       const listener = (event, data) => callback(event, data); // Pass event too, just in case
       console.log('[Preload] Setting up listener for file-extraction-status');
       ipcRenderer.on('file-extraction-status', listener);
       return () => {
            console.log('[Preload] Removing listener for file-extraction-status');
            ipcRenderer.removeListener('file-extraction-status', listener);
       };
  }
  // --- End File Extraction IPC ---
}); 