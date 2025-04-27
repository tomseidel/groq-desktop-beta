import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ToolsPanel from './components/ToolsPanel';
import ToolApprovalModal from './components/ToolApprovalModal';
import ChatListSidebar from './components/ChatListSidebar';
import { useChat } from './context/ChatContext'; // Import useChat hook
// import { get_encoding } from "@dqbd/tiktoken"; // Removed

// LocalStorage keys
const TOOL_APPROVAL_PREFIX = 'tool_approval_';
const YOLO_MODE_KEY = 'tool_approval_yolo_mode';

// --- LocalStorage Helper Functions ---
const getToolApprovalStatus = (toolName) => {
  try {
    const yoloMode = localStorage.getItem(YOLO_MODE_KEY);
    if (yoloMode === 'true') {
      return 'yolo';
    }
    const toolStatus = localStorage.getItem(`${TOOL_APPROVAL_PREFIX}${toolName}`);
    if (toolStatus === 'always') {
      return 'always';
    }
    // Default: prompt the user
    return 'prompt';
  } catch (error) {
    console.error("Error reading tool approval status from localStorage:", error);
    return 'prompt'; // Fail safe: prompt user if localStorage fails
  }
};

const setToolApprovalStatus = (toolName, status) => {
  try {
    if (status === 'yolo') {
      localStorage.setItem(YOLO_MODE_KEY, 'true');
      // Optionally clear specific tool settings when YOLO is enabled?
      // Object.keys(localStorage).forEach(key => {
      //   if (key.startsWith(TOOL_APPROVAL_PREFIX)) {
      //     localStorage.removeItem(key);
      //   }
      // });
    } else if (status === 'always') {
      localStorage.setItem(`${TOOL_APPROVAL_PREFIX}${toolName}`, 'always');
      // Ensure YOLO mode is off if a specific tool is set to always
      localStorage.removeItem(YOLO_MODE_KEY);
    } else if (status === 'once') {
      // 'once' doesn't change persistent storage, just allows current execution
      // Ensure YOLO mode is off if 'once' is chosen for a specific tool
      localStorage.removeItem(YOLO_MODE_KEY);
    } else if (status === 'deny') {
       // 'deny' also doesn't change persistent storage by default.
       // Could potentially add a 'never' status if needed.
       // Ensure YOLO mode is off if 'deny' is chosen
       localStorage.removeItem(YOLO_MODE_KEY);
    }
  } catch (error) {
    console.error("Error writing tool approval status to localStorage:", error);
  }
};
// --- End LocalStorage Helper Functions ---


function App() {
  // Use context state
  const { 
    messages, 
    setMessages, 
    activeChatId, 
    setActiveChatId, 
    savedChats, 
    setSavedChats,
    thinkingSteps, // Get thinkingSteps state
    setThinkingSteps // Get thinkingSteps setter
  } = useChat(); 
  const [loading, setLoading] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('groq'); // 'groq' or 'openrouter'
  const [selectedModel, setSelectedModel] = useState(''); // Model ID for the selected platform
  const [mcpTools, setMcpTools] = useState([]);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [mcpServersStatus, setMcpServersStatus] = useState({ loading: false, message: "" });
  const messagesEndRef = useRef(null);
  const chatInputRef = useRef(null); // Add ref for ChatInput
  // Store the list of models from capabilities keys
  // const models = Object.keys(MODEL_CONTEXT_SIZES).filter(key => key !== 'default'); // Old way
  const [modelConfigs, setModelConfigs] = useState({}); // State for model configurations
  const [models, setModels] = useState([]); // State for model list (now platform-specific)

  // State for current model's vision capability
  // const [visionSupported, setVisionSupported] = useState(false); // REMOVED STATE
  // Add state to track if initial model/settings load is complete
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // State to hold all fetched model configs (key = platform, value = { modelId: config })
  const [allPlatformModels, setAllPlatformModels] = useState({ groq: {}, openrouter: {} });

  // --- State for Tool Approval Flow ---
  const [pendingApprovalCall, setPendingApprovalCall] = useState(null); // Holds the tool call object needing approval
  const [pausedChatState, setPausedChatState] = useState(null); // Holds { currentMessages, finalAssistantMessage, accumulatedResponses }
  // --- End Tool Approval State ---

  const [lastSavedMessageId, setLastSavedMessageId] = useState(null); // Track last saved message

  const handleRemoveLastMessage = () => {
    setMessages(prev => {
      if (prev.length === 0) return prev;
      // Create a copy without the last message
      return prev.slice(0, prev.length - 1);
    });
  };
  
  // Models list derived from capabilities keys
  // const models = Object.keys(MODEL_CAPABILITIES).filter(key => key !== 'default');

  // Function to clear the entire chat
  const handleClearChat = () => {
    setMessages([]); // Clear messages from context
    setPendingApprovalCall(null); // Clear any pending tool approvals
    setPausedChatState(null); // Clear any paused state
    setLoading(false); // Ensure loading indicator is off
    console.log("Chat cleared.");
  };

  // --- Task 10: New Chat Logic ---
  const handleNewChat = () => {
    console.log("[handleNewChat] Called. Current activeChatId:", activeChatId);
    setMessages([]);      // Clear message history
    setActiveChatId(null); // Set active chat ID to null
    setPendingApprovalCall(null); // Clear any pending tool approvals
    setPausedChatState(null); // Clear any paused state
    setLoading(false); // Ensure loading indicator is off
    console.log("[handleNewChat] Finished clearing state.");
    // Focus the chat input after the next frame to ensure DOM update
    requestAnimationFrame(() => {
       chatInputRef.current?.focus(); 
    });
    // Do NOT automatically save here. Saving happens on the first message.
  };
  // --- End Task 10 ---

  // --- Task 11: Select Chat Logic ---
  const handleSelectChat = async (chatId) => {
    if (!chatId || chatId === activeChatId) {
        console.log(`Skipping chat selection: chatId is null, undefined, or already active (${chatId})`);
        return; // Do nothing if no ID or already selected
    }

    //console.log(`Attempting to select and load chat: ${chatId}`);
    setLoading(true); // Indicate loading state
    try {
        const loadResult = await window.electron.loadChat(chatId);

        if (loadResult && loadResult.success && loadResult.chatData) {
            // console.log(`Successfully loaded chat: ${loadResult.chatData.id}`);
            // Clear previous state before loading new chat
            setPendingApprovalCall(null); 
            setPausedChatState(null);
            
            setMessages(loadResult.chatData.messages || []);
            setActiveChatId(loadResult.chatData.id);

            // Set platform and model from loaded chat
            const { platform: loadedPlatform, model: loadedModel } = loadResult.chatData;

            if (loadedPlatform && allPlatformModels[loadedPlatform]) {
                setSelectedPlatform(loadedPlatform); // Update platform state
                // Ensure models for this platform are loaded (might need refresh if API keys changed)
                // Consider if a specific model load is needed here or rely on initial load
                await loadModelsForPlatform(loadedPlatform); // Reload models for the selected platform just in case

                // Now check if the specific model exists
                const currentModels = allPlatformModels[loadedPlatform] || {};
                if (loadedModel && currentModels[loadedModel]) {
                   setSelectedModel(loadedModel); // Update model state
                   console.log(`Set platform to ${loadedPlatform} and model to ${loadedModel} from loaded chat.`);
                } else {
                   console.warn(`Model ${loadedModel} not found for platform ${loadedPlatform}. Using default for platform.`);
                   // Let loadModelsForPlatform handle setting a default
                }
            } else {
                 console.warn(`Platform ${loadedPlatform} not recognized or models not loaded. Using current defaults.`);
                 // Keep existing platform/model or reset? For now, keep existing.
            }
        } else {
            console.error(`Failed to load selected chat ${chatId}:`, loadResult?.error || "Unknown error");
            // Optionally show an error message to the user
            // Maybe load a new chat instead? For now, just log error.
        }
    } catch (error) {
        console.error(`Error during chat selection for ${chatId}:`, error);
    } finally {
        setLoading(false); // Stop loading indicator
    }
  };
  // --- End Task 11 ---

  // --- Task 12 Helper: Save Chat Logic ---
  const saveCurrentChat = async (messagesToSave, currentActiveChatId) => {
    console.log(`[saveCurrentChat ENTRY] ActiveID Param: ${currentActiveChatId}, Messages Length: ${messagesToSave?.length}`);
    // Use the messages passed in
    if (!messagesToSave || messagesToSave.length === 0) {
      console.log("[saveCurrentChat] Skipping save: No messages provided.");
      return; 
    }

    // Find the existing title if we have an active chat ID
    // Use the passed currentActiveChatId for finding existing chat
    const existingChat = savedChats.find(chat => chat.id === currentActiveChatId); 
    const title = existingChat?.title; 

    // --- Transform messages for saving (match display format) ---
    const transformedMessages = messagesToSave.map(msg => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const newContent = msg.content.map(part => {
                if (part.type === 'file_content') {
                    return { type: 'text', text: `[Content of file: ${part.name}]

${part.content}` };
                } else if (part.type === 'file_error') {
                    return { type: 'text', text: `[Error processing file: ${part.name}: ${part.error}]` };
                }
                return part; // Keep other parts (text, image_url) as is
            });
            return { ...msg, content: newContent };
        }
        return msg; // Return non-user messages or user messages with string content unmodified
    });
    // --- End transformation ---

    const chatDataToSave = {
      id: currentActiveChatId, // Use the passed ID
      messages: transformedMessages, 
      platform: selectedPlatform,
      model: selectedModel,
      ...(title && { title: title }),
    };

    // --- Log messages being saved ---
    // console.log(`[saveCurrentChat] Saving transformed messages:`, JSON.stringify(transformedMessages, null, 2));
    // --- End Log ---

    // console.log(`[saveCurrentChat TRY] Saving ID: ${currentActiveChatId || '(new)'}`, chatDataToSave);
    try {
      const saveResult = await window.electron.saveChat(chatDataToSave);

      if (saveResult && saveResult.success && saveResult.savedChatData) {
        const savedData = saveResult.savedChatData;
        console.log(`[saveCurrentChat SUCCESS] Backend ID: ${savedData.id}. Setting activeChatId.`);
        setActiveChatId(savedData.id);
        console.log(`[saveCurrentChat] Set activeChatId to saved ID: ${savedData.id}`);
       
        console.log("[saveCurrentChat] Refreshing chat list after save...");
        const updatedChatList = await window.electron.listChats();
        setSavedChats(updatedChatList || []); 
        console.log(`[saveCurrentChat] Chat list refreshed. Count: ${updatedChatList?.length || 0}`);

      } else {
        console.error("[saveCurrentChat FAIL] Backend save failed:", saveResult?.error);
      }
    } catch (error) {
      console.error("[saveCurrentChat CATCH] Error calling IPC:", error);
    }
  };
  // --- End Task 12 Helper ---

  // --- Task 13: Delete Chat Logic ---
  const handleDeleteChat = async (chatIdToDelete) => {
    if (!chatIdToDelete) {
      console.error("handleDeleteChat called with no ID.");
      return;
    }

    // Add confirmation dialog
    if (!window.confirm(`Are you sure you want to delete chat "${savedChats.find(c=>c.id === chatIdToDelete)?.title || chatIdToDelete}"? This action cannot be undone.`)) {
      console.log(`Deletion cancelled for chat: ${chatIdToDelete}`);
      return;
    }

    console.log(`Attempting to delete chat: ${chatIdToDelete}`);
    try {
      const deleteResult = await window.electron.deleteChat(chatIdToDelete);

      if (deleteResult && deleteResult.success) {
        console.log(`Chat ${chatIdToDelete} deleted successfully.`);

        // Refresh the chat list immediately
        const updatedChatList = await window.electron.listChats();
        setSavedChats(updatedChatList || []);
        console.log(`Refreshed chat list, found ${updatedChatList?.length || 0} chats.`);

        // If the deleted chat was the active one, load another or start new
        if (activeChatId === chatIdToDelete) {
          console.log(`Deleted chat ${chatIdToDelete} was active. Selecting new chat...`);
          if (updatedChatList && updatedChatList.length > 0) {
            // Load the new most recent chat
            console.log(`Loading next most recent chat: ${updatedChatList[0].id}`);
            await handleSelectChat(updatedChatList[0].id);
          } else {
            // No chats left, start a new one
            console.log("No chats remaining, starting new session.");
            handleNewChat(); 
          }
        } else {
           console.log(`Deleted chat ${chatIdToDelete} was not active. Current chat remains: ${activeChatId}`);
           // Active chat wasn't deleted, no need to change view unless list update affects it
        }
      } else {
        console.error(`Failed to delete chat ${chatIdToDelete}:`, deleteResult?.error || "Unknown backend error");
        // Optionally notify the user
      }
    } catch (error) {
      console.error(`Error calling deleteChat IPC handler for ${chatIdToDelete}:`, error);
      // Optionally notify the user
    }
  };
  // --- End Task 13 ---

  // --- Phase 4: Rename Chat Logic ---
  const handleRenameChat = async (chatId, newTitle) => {
      console.log(`[handleRenameChat] Attempting to rename chat ${chatId} to "${newTitle}"`);
      if (!chatId || !newTitle || !newTitle.trim()) {
          console.error("[handleRenameChat] Invalid arguments provided.");
          return; // Or provide feedback
      }
      
      try {
          const renameResult = await window.electron.updateChatMetadata(chatId, { title: newTitle.trim() });
          
          if (renameResult && renameResult.success) {
              console.log(`[handleRenameChat] Chat ${chatId} renamed successfully.`);
              // Refresh list if the backend indicates a change occurred
              if (renameResult.needsRefresh) {
                 console.log("[handleRenameChat] Refreshing chat list after rename...");
                 const updatedChatList = await window.electron.listChats();
                 setSavedChats(updatedChatList || []);
              }
          } else {
               console.error(`[handleRenameChat] Failed to rename chat ${chatId}:`, renameResult?.error || "Unknown backend error");
              // Optionally notify user of failure
          }
      } catch (error) {
           console.error(`[handleRenameChat] Error calling updateChatMetadata IPC handler for ${chatId}:`, error);
           // Optionally notify user
      }
  };
  // --- End Phase 4 Rename ---

  // --- Function to load models for a specific platform ---
  const loadModelsForPlatform = async (platform) => {
      setLoading(true);
      // console.log(`Requesting models for platform: ${platform}`);
      try {
          const platformConfigs = await window.electron.getModelConfigs(); // This now returns models for the *currently selected* platform in backend settings
          console.log(`Received ${Object.keys(platformConfigs).length} models for ${platform}:`, platformConfigs);

          // Store these models under the specific platform key
          setAllPlatformModels(prev => ({ ...prev, [platform]: platformConfigs }));

          const availableModels = Object.keys(platformConfigs).filter(key => key !== 'default');
          setModels(availableModels); // Update UI dropdown list

          // Set a default model if the list isn't empty
          if (availableModels.length > 0) {
              // Try to use the globally saved model setting first, if it exists in this platform's list
              const settings = await window.electron.getSettings();
              const savedModel = settings.model;
              if (savedModel && platformConfigs[savedModel]) {
                  setSelectedModel(savedModel);
              } else {
                   // Otherwise, default to the first model in the new list
                   setSelectedModel(availableModels[0]);
              }
          } else {
              setSelectedModel(''); // No models available
          }

      } catch (error) {
          console.error(`Error loading models for platform ${platform}:`, error);
          setModels([]);
          setSelectedModel('');
          // Optionally show an error message to the user
      } finally {
          setLoading(false);
      }
  };

  // Function to update the server status display - moved outside useEffect
  const updateServerStatus = (tools, settings) => {
    try {
      // Get number of configured servers
      if (settings && settings.mcpServers) {
        const configuredCount = Object.keys(settings.mcpServers).length;
        
        // Get unique server IDs from the tools
        const connectedServerIds = new Set();
        if (Array.isArray(tools)) {
          tools.forEach(tool => {
            if (tool && tool.serverId) {
              connectedServerIds.add(tool.serverId);
            }
          });
        }
        const connectedCount = connectedServerIds.size;
        const toolCount = Array.isArray(tools) ? tools.length : 0;
        
        if (configuredCount > 0) {
          if (connectedCount === configuredCount) {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, ${connectedCount}/${configuredCount} MCP servers connected` 
            });
          } else if (connectedCount > 0) {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, ${connectedCount}/${configuredCount} MCP servers connected` 
            });
          } else {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, No MCP servers connected (${configuredCount} configured)` 
            });
          }
        } else {
          setMcpServersStatus({ loading: false, message: `${toolCount} tools, No MCP servers configured` });
        }
      } else {
        const toolCount = Array.isArray(tools) ? tools.length : 0;
        setMcpServersStatus({ loading: false, message: `${toolCount} tools available` });
      }
    } catch (error) {
      console.error('Error updating server status:', error);
      setMcpServersStatus({ loading: false, message: "Error updating server status" });
    }
  };

  // Load settings, MCP tools, and model configs when component mounts
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        // Set loading status
        setMcpServersStatus({ loading: true, message: "Connecting to MCP servers..." });

        // --- Load settings first to know the platform ---
        const settings = await window.electron.getSettings(); // Await settings
        const initialPlatform = settings.selectedPlatform || 'groq';
        setSelectedPlatform(initialPlatform);

        console.log(`Initial platform from settings: ${initialPlatform}`);

        // --- Load models for the initial platform ---
        // We need to ensure getModelConfigs reflects the loaded platform setting
        // The backend get-model-configs handler should now use settings.selectedPlatform
        await loadModelsForPlatform(initialPlatform);

        // Note: selectedModel is set within loadModelsForPlatform

        // --- Legacy: Original Settings/Model loading logic (kept for reference, mostly replaced) ---
        // let effectiveModel = models.length > 0 ? models[0] : ''; // Default based on newly loaded models
        // if (settings && settings.model) {
        //     // Check if the saved model is valid for the *initial* platform
        //     const initialPlatformModels = allPlatformModels[initialPlatform] || {};
        //     if (initialPlatformModels[settings.model]) {
        //         effectiveModel = settings.model;
        //     } else {
        //         console.warn(`Saved model "${settings.model}" not found for initial platform ${initialPlatform}. Falling back to ${effectiveModel}.`);
        //     }
        // }
        // setSelectedModel(effectiveModel);

        // THEN Load settings
        // const settings = await window.electron.getSettings(); // Await settings
        // let effectiveModel = availableModels.length > 0 ? availableModels[0] : 'default'; // Default fallback if no models or no setting

        // if (settings && settings.model) {
        //     // Ensure the saved model is still valid against the loaded configs
        //     if (configs[settings.model]) {
        //         effectiveModel = settings.model; // Use saved model if valid
        //     } else {
        //         // If saved model is invalid, keep the default fallback (first available model)
        //         console.warn(`Saved model "${settings.model}" not found in loaded configs. Falling back to ${effectiveModel}.`);
        //     }
        // } else if (availableModels.length > 0) {
        //      // If no model saved in settings, but models are available, use the first one
        //      effectiveModel = availableModels[0];
        // }
        // // If no model in settings and no available models, effectiveModel remains 'default'

        // setSelectedModel(effectiveModel); // Set the final selected model state


        // Initial load of MCP tools (can happen after model/settings)
        const mcpToolsResult = await window.electron.getMcpTools();
        // Use the already loaded settings object here for initial status update
        if (mcpToolsResult && mcpToolsResult.tools) {
          setMcpTools(mcpToolsResult.tools);
          updateServerStatus(mcpToolsResult.tools, settings); // Pass loaded settings
        } else {
           // Handle case where no tools are found initially, but update status
           updateServerStatus([], settings);
        }

        // Set up event listener for MCP server status changes
        const removeListener = window.electron.onMcpServerStatusChanged((data) => {
          if (data && data.tools !== undefined) { // Check if tools property exists
            setMcpTools(data.tools);
            // Fetch latest settings again when status changes, as they might have been updated
            window.electron.getSettings().then(currentSettings => {
               updateServerStatus(data.tools, currentSettings);
            }).catch(err => {
                console.error("Error fetching settings for status update:", err);
                // Fallback to updating status without settings info
                updateServerStatus(data.tools, null);
            });
          }
        });

        // --- Task 9: Load Initial Chat List and Potentially Load Last Chat ---
        console.log("Loading initial chat list...");
        const chatList = await window.electron.listChats();
        setSavedChats(chatList || []); // Update context
        console.log(`Found ${chatList?.length || 0} saved chats.`);

        if (chatList && chatList.length > 0) {
          const mostRecentChat = chatList[0]; // Backend sorts by lastModified desc
          console.log(`Attempting to load most recent chat: ${mostRecentChat.id} (${mostRecentChat.title})`);
          const loadResult = await window.electron.loadChat(mostRecentChat.id);

          if (loadResult && loadResult.success && loadResult.chatData) {
            // console.log(`Successfully loaded chat: ${loadResult.chatData.id}`);
            setMessages(loadResult.chatData.messages || []);
            setActiveChatId(loadResult.chatData.id);
            // Set platform and model based on the loaded chat
            // Ensure platform is loaded first before model
            if (loadResult.chatData.platform && allPlatformModels[loadResult.chatData.platform]) {
              setSelectedPlatform(loadResult.chatData.platform);
              // Make sure the model exists for the loaded platform
              if (loadResult.chatData.model && allPlatformModels[loadResult.chatData.platform][loadResult.chatData.model]) {
                setSelectedModel(loadResult.chatData.model);
                 console.log(`Set platform to ${loadResult.chatData.platform} and model to ${loadResult.chatData.model} from loaded chat.`);
              } else {
                console.warn(`Model ${loadResult.chatData.model} not found for platform ${loadResult.chatData.platform}. Using default.`);
                // Fallback logic already exists in loadModelsForPlatform, should be okay
              }
            } else {
               console.warn(`Platform ${loadResult.chatData.platform} not recognized or models not loaded. Using current defaults.`);
            }
          } else {
            console.error(`Failed to load most recent chat ${mostRecentChat.id}:`, loadResult?.error || "Unknown error");
            // Start a new chat if loading failed
            setMessages([]);
            setActiveChatId(null);
          }
        } else {
          // No saved chats, start a new one
          console.log("No saved chats found. Starting a new chat session.");
          setMessages([]);
          setActiveChatId(null);
        }
        // --- End Task 9 ---

        // Clean up the event listener when component unmounts
        return () => {
          if (removeListener) removeListener();
        };
      } catch (error) {
        console.error('Error loading initial data:', error);
        setMcpServersStatus({ loading: false, message: "Error loading initial data" });
      } finally {
          // Mark initial load as complete regardless of success/failure
          setInitialLoadComplete(true);
      }
    };

    loadInitialData();
  }, []); // Empty dependency array ensures this runs only once on mount

  // Save model selection to settings when it changes, ONLY after initial load
  useEffect(() => {
    // Prevent saving during initial setup before models/settings are loaded/validated
    if (!initialLoadComplete) {
        return;
    }

    // Ensure models list isn't empty and selectedModel is valid for the CURRENT platform
    const currentPlatformModels = allPlatformModels[selectedPlatform] || {};
    if (Object.keys(currentPlatformModels).length === 0 || !selectedModel || !currentPlatformModels[selectedModel]) {
        console.warn("Skipping model save: Models not loaded for current platform or no valid model selected.");
        return;
    }

    const saveModelSelection = async () => {
      try {
        // console.log(`Attempting to save selected model: ${selectedModel}`); // Debug log
        const settings = await window.electron.getSettings();
        // Check if the model actually changed before saving
        if (settings.model !== selectedModel) {
            //console.log(`Saving new model selection: ${selectedModel}`);
            await window.electron.saveSettings({ ...settings, model: selectedModel });
        } else {
            // console.log("Model selection hasn't changed, skipping save."); // Optional: Log skips
        }
      } catch (error) {
        console.error('Error saving model selection:', error);
      }
    };

    saveModelSelection();
    // Depend on initialLoadComplete as well to trigger after load finishes
  }, [selectedModel, initialLoadComplete, selectedPlatform, allPlatformModels]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const executeToolCall = async (toolCall) => {
    try {
      const response = await window.electron.executeToolCall(toolCall);
      //console.log(`Tool call response: ${JSON.stringify(response)}`);
      // Return the tool response message in the correct format
      return {
        role: 'tool',
        content: response.error ? JSON.stringify({ error: response.error }) : (response.result || ''),
        tool_call_id: toolCall.id
      };
    } catch (error) {
      console.error('Error executing tool call:', error);
      return { 
        role: 'tool', 
        content: JSON.stringify({ error: error.message }),
        tool_call_id: toolCall.id
      };
    }
  };

  // Refactored processToolCalls to handle sequential checking and pausing
  const processToolCalls = async (assistantMessage, currentMessagesBeforeAssistant) => {
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return { status: 'completed', toolResponseMessages: [] };
    }

    const toolResponseMessages = [];
    let needsPause = false;

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const approvalStatus = getToolApprovalStatus(toolName);

      if (approvalStatus === 'always' || approvalStatus === 'yolo') {
        console.log(`Tool '${toolName}' automatically approved (${approvalStatus}). Executing...`);
        try {
          const resultMsg = await executeToolCall(toolCall);
          toolResponseMessages.push(resultMsg);
          // Update UI immediately for executed tool calls
          setMessages(prev => [...prev, resultMsg]);
        } catch (error) {
           console.error(`Error executing automatically approved tool call '${toolName}':`, error);
           const errorMsg = {
               role: 'tool',
               content: JSON.stringify({ error: `Error executing tool '${toolName}': ${error.message}` }),
               tool_call_id: toolCall.id
           };
           toolResponseMessages.push(errorMsg);
           setMessages(prev => [...prev, errorMsg]); // Show error in UI
        }
      } else { // status === 'prompt'
        console.log(`Tool '${toolName}' requires user approval.`);
        setPendingApprovalCall(toolCall);
        setPausedChatState({
          currentMessages: currentMessagesBeforeAssistant, // History before this assistant message
          finalAssistantMessage: assistantMessage,
          accumulatedResponses: toolResponseMessages // Responses gathered *before* this pause
        });
        needsPause = true;
        break; // Stop processing further tools for this turn
      }
    }

    if (needsPause) {
      return { status: 'paused', toolResponseMessages };
    } else {
      return { status: 'completed', toolResponseMessages };
    }
  };

  // Core function to execute a chat turn (fetch response, handle tools)
  // Refactored from the main loop of handleSendMessage
  const executeChatTurn = async (turnMessages) => {
    let currentTurnStatus = 'processing';
    let turnAssistantMessage = null;
    let turnToolResponses = [];

    try {
        // Create a streaming assistant message placeholder with initial status
        const assistantPlaceholder = {
            role: 'assistant',
            // Assign a temporary unique ID to link thinking steps
            id: `assistant-placeholder-${Date.now()}-${Math.random()}`,
            content: '', // Initial text
            finalContent: '', // Text after tool calls
            status: 'streaming_text', // Initial status
            isStreaming: true, // Keep this flag for finding the placeholder
            tool_calls: [] // Initialize tool_calls array
        };
        setMessages(prev => [...prev, assistantPlaceholder]);
        // Initialize thinking steps for this placeholder
        setThinkingSteps(prev => ({ ...prev, [assistantPlaceholder.id]: {} }));

        // Start streaming chat
        // NOTE: We pass the messages *before* adding the placeholder, 
        // as the backend handles the history.
        const streamHandler = window.electron.startChatStream(turnMessages, selectedModel);

        // Setup event handlers for streaming
        streamHandler.onStart((startData) => { 
            currentTurnStreamId = startData.id; // Capture the stream ID
            console.log("[onStart] Stream started:", startData);
        });

        // Listen for signal that the *final* response stream is starting
        streamHandler.onFinalStart(({ id }) => {
            console.log(`[onFinalStart] Final stream starting for ID: ${id}`);
            setMessages(prev => prev.map(msg => 
                msg.id === assistantPlaceholder.id ? { ...msg, status: 'streaming_final_response' } : msg
            ));
        });

        streamHandler.onContent(({ content }) => {
            setMessages(prevMessages => {
                const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                if (idx !== -1) {
                    const updatedMessages = [...prevMessages];
                    const currentMsg = updatedMessages[idx];
                    // Append to correct content field based on status
                    if (currentMsg.status === 'streaming_final_response') {
                         updatedMessages[idx] = {
                            ...currentMsg,
                            finalContent: (currentMsg.finalContent || '') + content
                        };
                    } else { // Assumed streaming_text or processing_tools
                         updatedMessages[idx] = {
                            ...currentMsg,
                            content: (currentMsg.content || '') + content
                        };
                    }
                    return updatedMessages;
                }
                return prevMessages;
            });
        });
        
        // Capture tool calls associated with the assistant message
        streamHandler.onToolCalls(({ tool_calls }) => {
            console.log("[onToolCalls] Received tool calls:", tool_calls);
            setMessages(prev => prev.map(msg => 
                msg.id === assistantPlaceholder.id ? { ...msg, tool_calls: tool_calls } : msg
            ));
        });

        // *** NEW: Handle Tool Call Start ***
        streamHandler.onToolCallStart(({ callId, name, args }) => {
             console.log(`[onToolCallStart] Tool: ${name}, ID: ${callId}, Args:`, args);
             // Ensure we update the correct message (identified by placeholder ID)
             setMessages(prev => prev.map(msg => 
                 msg.id === assistantPlaceholder.id ? { ...msg, status: 'processing_tools' } : msg
             ));
             setThinkingSteps(prev => ({
                 ...prev,
                 [assistantPlaceholder.id]: {
                     ...(prev[assistantPlaceholder.id] || {}),
                     // Store full details for this specific tool call
                     [callId]: { name, args, status: 'executing', result: null, error: null } 
                 }
             }));
         });

        // *** NEW: Handle Tool Call End ***
        streamHandler.onToolCallEnd(({ callId, name, result, error }) => {
             console.log(`[onToolCallEnd] ID: ${callId}, Error: ${!!error}, Result:`, result);
             // Update thinking steps state
             let thinkingStepName = 'unknown_tool'; // Default name
             setThinkingSteps(prev => {
                 const currentSteps = prev[assistantPlaceholder.id] || {};
                 if (!currentSteps[callId]) {
                     console.warn(`[onToolCallEnd] Thinking step for callId ${callId} not found.`);
                     currentSteps[callId] = { name: name || 'unknown_tool', args: {}, status: 'executing' }; 
                 }
                 thinkingStepName = currentSteps[callId].name; // Capture name for tool message
                 const updatedStep = { 
                     ...currentSteps[callId], 
                     status: error ? 'error' : 'complete', 
                     result: error ? null : result, 
                     error: error ? error : null 
                 };
                 return {
                     ...prev,
                     [assistantPlaceholder.id]: { 
                         ...currentSteps, 
                         [callId]: updatedStep 
                     }
                 };
             });
             
             // *** ADD the role:"tool" message to the main messages state ***
             const toolResponseMessage = {
                 role: "tool",
                 id: callId, 
                 tool_call_id: callId,
                 name: thinkingStepName || 'unknown_tool', 
                 content: error ? `Error: ${error}` : result 
             };
            
             // Add the tool message *after* the assistant placeholder
             setMessages(prevMessages => {
                 const assistantIndex = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                 if (assistantIndex !== -1) {
                     // Insert after the assistant message
                     const newMessages = [
                         ...prevMessages.slice(0, assistantIndex + 1),
                         toolResponseMessage,
                         ...prevMessages.slice(assistantIndex + 1)
                     ];
                     return newMessages;
                 } else {
                     // Fallback: Append if placeholder not found (shouldn't happen ideally)
                     console.warn(`[onToolCallEnd] Assistant placeholder ${assistantPlaceholder.id} not found, appending tool message.`);
                     return [...prevMessages, toolResponseMessage];
                 }
            });
         });

        // Handle stream completion (this receives the *final* message data)
        await new Promise((resolve, reject) => {
            streamHandler.onComplete((finalData) => {
                console.log("[onComplete] Final data received:", finalData);
                let finalStateForSave;
                setMessages(prevMessages => {
                    const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                    let updatedMessages = prevMessages;
                    if (idx !== -1) {
                        const currentMsg = prevMessages[idx];
                        const finalContentFromStream = currentMsg.finalContent || ''; 
                        const initialContent = currentMsg.content;
                        
                        const finalMessage = {
                           ...currentMsg, 
                            finalContent: finalContentFromStream, 
                            status: 'complete', 
                            isStreaming: false 
                        };
                        updatedMessages = [
                            ...prevMessages.slice(0, idx),
                            finalMessage,
                            ...prevMessages.slice(idx + 1)
                        ];
                    } else { 
                        console.warn("[onComplete] Placeholder not found for final update.");
                    }
                    finalStateForSave = updatedMessages; 
                    return updatedMessages;
                });
                setLoading(false); 
                resolve(); 
            });

            streamHandler.onError(({ error }) => {
                 console.error("[onError] Stream error:", error);
                 let finalStateForSave;
                  setMessages(prevMessages => {
                     const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                     let updatedMessages = prevMessages;
                     if (idx !== -1) {
                         updatedMessages = [...prevMessages];
                         updatedMessages[idx] = {
                             ...updatedMessages[idx], 
                             content: (updatedMessages[idx].content || '') + `\n\n**Stream Error:** ${error || 'Unknown streaming error'}`,
                             status: 'error', 
                             isStreaming: false 
                         };
                     } else {
                         console.warn("[onError] Placeholder not found for error update.");
                     }
                     finalStateForSave = updatedMessages; 
                     return updatedMessages; 
                 });
                 setThinkingSteps(prev => {
                     // ... (clear thinking steps) ...
                 });
                 setLoading(false); 
                 reject(new Error(error || 'Unknown streaming error'));
            });

        }); // End Promise

        streamHandler.cleanup();
        
        // Remove the complex logic that tried to re-run the loop after tool calls
        // The backend now handles the two-step process.
        // The final onComplete/onTurnComplete marks the end of the interaction.

    } catch (error) {
        // ... (catch block sets UI state) ...
        currentTurnStatus = 'error';
    }

    // Construct final message list reliably HERE
    let finalMessagesForTurn = turnMessages; // Start with input
    if (turnAssistantMessage) {
        finalMessagesForTurn = [...finalMessagesForTurn, turnAssistantMessage];
    }
    if (currentTurnStatus === 'completed_with_tools' && turnToolResponses.length > 0) {
         const formattedToolResponses = turnToolResponses.map(msg => ({
             role: 'tool',
             content: msg.content,
             tool_call_id: msg.tool_call_id
         }));
        finalMessagesForTurn = [...finalMessagesForTurn, ...formattedToolResponses];
    }
     // Note: If status is 'paused' or 'error', finalMessagesForTurn might only contain up to the assistant message

    return {
        status: currentTurnStatus,
        assistantMessage: turnAssistantMessage,
        toolResponseMessages: turnToolResponses,
        finalMessages: finalMessagesForTurn // Return the reliably constructed list
    };
  };

  // --- Handle Platform Change --- //
  const handlePlatformChange = async (newPlatform) => {
    if (newPlatform === selectedPlatform) return; // No change

    console.log(`Switching platform to: ${newPlatform}`);
    setSelectedPlatform(newPlatform);
    setModels([]); // Clear current model list
    setSelectedModel(''); // Clear selected model
    // setVisionSupported(false); // REMOVED

    // Save the new platform selection to settings
    try {
      const settings = await window.electron.getSettings();
      await window.electron.saveSettings({ ...settings, selectedPlatform: newPlatform });
    } catch (error) {
      console.error('Error saving platform selection:', error);
      // Handle error - maybe revert UI or show message?
    }

    // Load models for the new platform
    await loadModelsForPlatform(newPlatform);
  };

  // Handle sending message (text or structured content with images)
  const handleSendMessage = async (content) => {
    let currentTurnStreamId = null; // Track the stream ID for this turn

    // Check if content is structured (array) or just text (string)
    const isStructuredContent = Array.isArray(content);
    const hasContent = isStructuredContent ? content.some(part => (part.type === 'text' && part.text.trim()) || part.type === 'image_url') : content.trim();

    if (!hasContent) return;

    // Format the user message based on content type
    const userMessage = {
      role: 'user',
      // Assign a temporary unique ID to the user message if needed for linking
      id: `user-${Date.now()}-${Math.random()}`,
      content: content
    };
    const initialMessages = [...messages, userMessage];
    setMessages(initialMessages);

    setLoading(true);

    try {
        // Create a streaming assistant message placeholder with initial status
        const assistantPlaceholder = {
            role: 'assistant',
            // Assign a temporary unique ID to link thinking steps
            id: `assistant-placeholder-${Date.now()}-${Math.random()}`,
            content: '', // Initial text
            finalContent: '', // Text after tool calls
            status: 'streaming_text', // Initial status
            isStreaming: true, // Keep this flag for finding the placeholder
            tool_calls: [] // Initialize tool_calls array
        };
        setMessages(prev => [...prev, assistantPlaceholder]);
        // Initialize thinking steps for this placeholder
        setThinkingSteps(prev => ({ ...prev, [assistantPlaceholder.id]: {} }));

        // Start streaming chat
        // NOTE: We pass the messages *before* adding the placeholder, 
        // as the backend handles the history.
        const streamHandler = window.electron.startChatStream(initialMessages, selectedModel);

        // Setup event handlers for streaming
        streamHandler.onStart((startData) => { 
            currentTurnStreamId = startData.id; // Capture the stream ID
            console.log("[onStart] Stream started:", startData);
        });

        // Listen for signal that the *final* response stream is starting
        streamHandler.onFinalStart(({ id }) => {
            console.log(`[onFinalStart] Final stream starting for ID: ${id}`);
            setMessages(prev => prev.map(msg => 
                msg.id === assistantPlaceholder.id ? { ...msg, status: 'streaming_final_response' } : msg
            ));
        });

        streamHandler.onContent(({ content }) => {
            setMessages(prevMessages => {
                const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                if (idx !== -1) {
                    const updatedMessages = [...prevMessages];
                    const currentMsg = updatedMessages[idx];
                    // Append to correct content field based on status
                    if (currentMsg.status === 'streaming_final_response') {
                         updatedMessages[idx] = {
                            ...currentMsg,
                            finalContent: (currentMsg.finalContent || '') + content
                        };
                    } else { // Assumed streaming_text or processing_tools
                         updatedMessages[idx] = {
                            ...currentMsg,
                            content: (currentMsg.content || '') + content
                        };
                    }
                    return updatedMessages;
                }
                return prevMessages;
            });
        });
        
        // Capture tool calls associated with the assistant message
        streamHandler.onToolCalls(({ tool_calls }) => {
            console.log("[onToolCalls] Received tool calls:", tool_calls);
            setMessages(prev => prev.map(msg => 
                msg.id === assistantPlaceholder.id ? { ...msg, tool_calls: tool_calls } : msg
            ));
        });

        // *** NEW: Handle Tool Call Start ***
        streamHandler.onToolCallStart(({ callId, name, args }) => {
             console.log(`[onToolCallStart] Tool: ${name}, ID: ${callId}, Args:`, args);
             // Ensure we update the correct message (identified by placeholder ID)
             setMessages(prev => prev.map(msg => 
                 msg.id === assistantPlaceholder.id ? { ...msg, status: 'processing_tools' } : msg
             ));
             setThinkingSteps(prev => ({
                 ...prev,
                 [assistantPlaceholder.id]: {
                     ...(prev[assistantPlaceholder.id] || {}),
                     // Store full details for this specific tool call
                     [callId]: { name, args, status: 'executing', result: null, error: null } 
                 }
             }));
         });

        // *** NEW: Handle Tool Call End ***
        streamHandler.onToolCallEnd(({ callId, name, result, error }) => {
             console.log(`[onToolCallEnd] ID: ${callId}, Error: ${!!error}, Result:`, result);
             // Update thinking steps state
             let thinkingStepName = 'unknown_tool'; // Default name
             setThinkingSteps(prev => {
                 const currentSteps = prev[assistantPlaceholder.id] || {};
                 if (!currentSteps[callId]) {
                     console.warn(`[onToolCallEnd] Thinking step for callId ${callId} not found.`);
                     currentSteps[callId] = { name: name || 'unknown_tool', args: {}, status: 'executing' }; 
                 }
                 thinkingStepName = currentSteps[callId].name; // Capture name for tool message
                 const updatedStep = { 
                     ...currentSteps[callId], 
                     status: error ? 'error' : 'complete', 
                     result: error ? null : result, 
                     error: error ? error : null 
                 };
                 return {
                     ...prev,
                     [assistantPlaceholder.id]: { 
                         ...currentSteps, 
                         [callId]: updatedStep 
                     }
                 };
             });
             
             // *** ADD the role:"tool" message to the main messages state ***
             const toolResponseMessage = {
                 role: "tool",
                 id: callId, 
                 tool_call_id: callId,
                 name: thinkingStepName || 'unknown_tool', 
                 content: error ? `Error: ${error}` : result 
             };
            
             // Add the tool message *after* the assistant placeholder
             setMessages(prevMessages => {
                 const assistantIndex = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                 if (assistantIndex !== -1) {
                     // Insert after the assistant message
                     const newMessages = [
                         ...prevMessages.slice(0, assistantIndex + 1),
                         toolResponseMessage,
                         ...prevMessages.slice(assistantIndex + 1)
                     ];
                     return newMessages;
                 } else {
                     // Fallback: Append if placeholder not found (shouldn't happen ideally)
                     console.warn(`[onToolCallEnd] Assistant placeholder ${assistantPlaceholder.id} not found, appending tool message.`);
                     return [...prevMessages, toolResponseMessage];
                 }
            });
         });

        // Handle stream completion (this receives the *final* message data)
        await new Promise((resolve, reject) => {
            streamHandler.onComplete((finalData) => {
                console.log("[onComplete] Final data received:", finalData);
                let finalStateForSave;
                setMessages(prevMessages => {
                    const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                    let updatedMessages = prevMessages;
                    if (idx !== -1) {
                        const currentMsg = prevMessages[idx];
                        const finalContentFromStream = currentMsg.finalContent || ''; 
                        const initialContent = currentMsg.content;
                        
                        const finalMessage = {
                           ...currentMsg, 
                            finalContent: finalContentFromStream, 
                            status: 'complete', 
                            isStreaming: false 
                        };
                        updatedMessages = [
                            ...prevMessages.slice(0, idx),
                            finalMessage,
                            ...prevMessages.slice(idx + 1)
                        ];
                    } else { 
                        console.warn("[onComplete] Placeholder not found for final update.");
                    }
                    finalStateForSave = updatedMessages; 
                    return updatedMessages;
                });
                setLoading(false); 
                resolve(); 
            });

            streamHandler.onError(({ error }) => {
                 console.error("[onError] Stream error:", error);
                 let finalStateForSave;
                  setMessages(prevMessages => {
                     const idx = prevMessages.findIndex(msg => msg.id === assistantPlaceholder.id);
                     let updatedMessages = prevMessages;
                     if (idx !== -1) {
                         updatedMessages = [...prevMessages];
                         updatedMessages[idx] = {
                             ...updatedMessages[idx], 
                             content: (updatedMessages[idx].content || '') + `\n\n**Stream Error:** ${error || 'Unknown streaming error'}`,
                             status: 'error', 
                             isStreaming: false 
                         };
                     } else {
                         console.warn("[onError] Placeholder not found for error update.");
                     }
                     finalStateForSave = updatedMessages; 
                     return updatedMessages; 
                 });
                 setThinkingSteps(prev => {
                     // ... (clear thinking steps) ...
                 });
                 setLoading(false); 
                 reject(new Error(error || 'Unknown streaming error'));
            });

        }); // End Promise

        streamHandler.cleanup();
        
        // Remove the complex logic that tried to re-run the loop after tool calls
        // The backend now handles the two-step process.
        // The final onComplete/onTurnComplete marks the end of the interaction.

    } catch (error) {
        console.error('Error in handleSendMessage streaming:', error);
        // Error handling within the stream listeners should cover most cases
        // But add a fallback here
         setMessages(prev => {
             // Try to find placeholder and mark error, or add new error message
             const idx = prev.findIndex(msg => msg.id === assistantPlaceholder?.id);
             if (idx !== -1) {
                 const updated = [...prev];
                 updated[idx] = { ...updated[idx], status: 'error', isStreaming: false, content: (updated[idx].content || '') + `\n\n**Error:** ${error.message}` };
                 return updated;
             } else {
                 return [...prev, { role: 'assistant', content: `Error: ${error.message}`, status: 'error' }];
             }
         });
         // Clear thinking steps on outer error
         if (assistantPlaceholder?.id) {
             setThinkingSteps(prev => {
                 const newState = { ...prev };
                 delete newState[assistantPlaceholder.id];
                 return newState;
             });
         }
         setLoading(false); // Ensure loading stops on outer catch
    } finally {
        // setLoading(false); // Moved to onTurnComplete or onError
        // saveCurrentChat(?); // Consider saving based on successful onTurnComplete
        console.log("[handleSendMessage] Finally block reached.");
    }
  };

  // --- Placeholder for resuming chat after modal interaction ---
  const resumeChatFlow = async (handledToolResponse) => {
     if (!pausedChatState) {
         console.error("Attempted to resume chat flow without paused state.");
         setLoading(false); // Ensure loading indicator stops
         return;
     }

     const { currentMessages, finalAssistantMessage, accumulatedResponses } = pausedChatState;
     setPausedChatState(null); // Clear the paused state

     const allResponsesForTurn = [...accumulatedResponses, handledToolResponse];

     // Find the index of the tool that caused the pause
     const pausedToolIndex = finalAssistantMessage.tool_calls.findIndex(
         tc => tc.id === handledToolResponse.tool_call_id // Match based on ID
     );

     if (pausedToolIndex === -1) {
          console.error("Could not find the paused tool call in the original message.");
          setLoading(false);
          return; // Cannot proceed
     }

     const remainingTools = finalAssistantMessage.tool_calls.slice(pausedToolIndex + 1);
     let needsPauseAgain = false;

     // Process remaining tools
     for (const nextToolCall of remainingTools) {
        const toolName = nextToolCall.function.name;
        const approvalStatus = getToolApprovalStatus(toolName);

        if (approvalStatus === 'always' || approvalStatus === 'yolo') {
            console.log(`Resuming: Tool '${toolName}' automatically approved (${approvalStatus}). Executing...`);
            try {
                const resultMsg = await executeToolCall(nextToolCall);
                allResponsesForTurn.push(resultMsg);
                setMessages(prev => [...prev, resultMsg]); // Update UI immediately
            } catch (error) {
                console.error(`Resuming: Error executing tool call '${toolName}':`, error);
                const errorMsg = { role: 'tool', content: JSON.stringify({ error: `Error executing tool '${toolName}': ${error.message}` }), tool_call_id: nextToolCall.id };
                allResponsesForTurn.push(errorMsg);
                setMessages(prev => [...prev, errorMsg]);
            }
        } else { // Needs prompt again
            console.log(`Resuming: Tool '${toolName}' requires user approval.`);
            setPendingApprovalCall(nextToolCall);
            // Save state again, including the responses gathered *during* this resume attempt
            setPausedChatState({
                currentMessages: currentMessages, // Original messages before assistant response
                finalAssistantMessage: finalAssistantMessage,
                accumulatedResponses: allResponsesForTurn // All responses UP TO this new pause
            });
            needsPauseAgain = true;
            break; // Stop processing remaining tools
        }
     }

     if (needsPauseAgain) {
        // Loading state remains true, waiting for the next modal interaction
        console.log("Chat flow paused again for the next tool.");
     } else {
        // All remaining tools were processed. Prepare for the next API call.
        console.log("All tools for the turn processed. Continuing conversation.");
        setLoading(true); // Show loading for the next API call

        const nextApiMessages = [
            ...currentMessages, // History BEFORE the assistant message with tools
            { // The assistant message itself
                role: finalAssistantMessage.role,
                content: finalAssistantMessage.content,
                tool_calls: finalAssistantMessage.tool_calls,
            },
            // Map ALL tool responses for the completed turn
            ...allResponsesForTurn.map(msg => ({
                role: 'tool',
                content: msg.content,
                tool_call_id: msg.tool_call_id
            }))
        ];

        // Continue the conversation loop by executing the next turn
        // This recursively calls the main logic, effectively continuing the loop
        // Pass the fully prepared message list for the *next* API call
        // We need to handle the loading state correctly after this returns
        try {
             // Start the next turn and get its results
             const { status: nextTurnStatus, finalMessages: finalMessagesAfterResume } = await executeChatTurn(nextApiMessages);

             // If the *next* turn also pauses, loading state remains true, otherwise stop loading
             if (nextTurnStatus !== 'paused') {
                 setLoading(false);
                 // --- Task 12 (Revised): Save chat after successful resume/completion ---
                 console.log(`[resumeChatFlow] Resumed turn completed. Status: ${nextTurnStatus}. Calling saveCurrentChat.`);
                 saveCurrentChat(finalMessagesAfterResume, activeChatId); // Save the definitive final list
                 // --- End Task 12 --- 
             } else {
                // It paused again, do not set loading false
                 console.log("[resumeChatFlow] Resumed turn resulted in another pause.");
             }
        } catch (error) {
            console.error("Error during resumed chat turn:", error);
            setLoading(false); // Stop loading on error
        }
     }
  };

  // --- Placeholder for handling modal choice ---
  const handleToolApproval = async (choice, toolCall) => {
     if (!toolCall || !toolCall.id) {
         console.error("handleToolApproval called with invalid toolCall:", toolCall);
         return;
     }
     console.log(`User choice for tool '${toolCall.function.name}': ${choice}`);

     // Update localStorage based on choice
     setToolApprovalStatus(toolCall.function.name, choice);

     // Clear the pending call *before* executing/resuming
     setPendingApprovalCall(null);

     let handledToolResponse;

     if (choice === 'deny') {
         handledToolResponse = {
             role: 'tool',
             content: JSON.stringify({ error: 'Tool execution denied by user.' }),
             tool_call_id: toolCall.id
         };
         setMessages(prev => [...prev, handledToolResponse]); // Show denial in UI
         // Resume processing potential subsequent tools
         await resumeChatFlow(handledToolResponse);
     } else { // 'once', 'always', 'yolo' -> Execute the tool
         setLoading(true); // Show loading specifically for tool execution phase
         try {
             console.log(`Executing tool '${toolCall.function.name}' after user approval...`);
             handledToolResponse = await executeToolCall(toolCall);
             setMessages(prev => [...prev, handledToolResponse]); // Show result in UI
             // Resume processing potential subsequent tools
             await resumeChatFlow(handledToolResponse);
         } catch (error) {
             console.error(`Error executing approved tool call '${toolCall.function.name}':`, error);
             handledToolResponse = {
                 role: 'tool',
                 content: JSON.stringify({ error: `Error executing tool '${toolCall.function.name}' after approval: ${error.message}` }),
                 tool_call_id: toolCall.id
             };
             setMessages(prev => [...prev, handledToolResponse]); // Show error in UI
              // Still try to resume processing subsequent tools even if this one failed
             await resumeChatFlow(handledToolResponse);
         } finally {
              // Loading state will be handled by resumeChatFlow or set to false if it errors/completes fully
              // setLoading(false); // Don't set false here, resumeChatFlow handles it
         }
     }
  };

  // Disconnect from an MCP server
  const disconnectMcpServer = async (serverId) => {
    try {
      const result = await window.electron.disconnectMcpServer(serverId);
      if (result && result.success) {
        if (result.allTools) {
          setMcpTools(result.allTools);
        } else {
          // If we don't get allTools back, just filter out the tools from this server
          setMcpTools(prev => prev.filter(tool => tool.serverId !== serverId));
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error disconnecting from MCP server:', error);
      return false;
    }
  };
  
  // Reconnect to an MCP server
  const reconnectMcpServer = async (serverId) => {
    try {
      // Get server configuration from settings
      const settings = await window.electron.getSettings();
      if (!settings.mcpServers || !settings.mcpServers[serverId]) {
        console.error(`Server configuration not found for ${serverId}`);
        return false;
      }
      
      // Get the full configuration object for the server
      const serverConfig = settings.mcpServers[serverId];

      // Connect to the server
      const result = await window.electron.connectMcpServer({
        ...serverConfig, // Spread the loaded config (includes transport, url/command, args, env)
        id: serverId      // Ensure ID is explicitly included
      });
      
      if (result && result.success) {
        // Make sure allTools exists before updating state
        if (result.allTools) {
          setMcpTools(result.allTools);
        } else if (result.tools) {
          // If allTools is missing but we have tools, use those
          setMcpTools(prev => {
            // Filter out tools from the same serverId and add new ones
            const filteredTools = prev.filter(tool => tool.serverId !== serverId);
            return [...filteredTools, ...(result.tools || [])];
          });
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error reconnecting to MCP server:', error);
      return false;
    }
  };

  // Add this function to explicitly refresh MCP tools
  const refreshMcpTools = async () => {
    try {
      setMcpServersStatus({ loading: true, message: "Refreshing MCP connections..." });
      
      // Get latest settings
      const settings = await window.electron.getSettings();
      
      // Manually fetch the current tools
      const mcpToolsResult = await window.electron.getMcpTools();
      
      if (mcpToolsResult && mcpToolsResult.tools) {
        setMcpTools(mcpToolsResult.tools);
        updateServerStatus(mcpToolsResult.tools, settings);
      } else {
        console.warn("No MCP tools available");
        setMcpServersStatus({ loading: false, message: "No MCP tools available" });
      }
    } catch (error) {
      console.error('Error refreshing MCP tools:', error);
      setMcpServersStatus({ loading: false, message: "Error refreshing MCP tools" });
    }
  };

  // --- Calculate derived state --- //
  const isVisionSupported = allPlatformModels[selectedPlatform]?.[selectedModel]?.vision_supported || false;
  const currentModelInfo = allPlatformModels[selectedPlatform]?.[selectedModel] || null;

  // Effect to save chat when a turn completes
  useEffect(() => {
    if (!initialLoadComplete || !messages || messages.length === 0) return;

    // Find the *latest* assistant message that is complete or errored
    let messageToSave = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && (msg.status === 'complete' || msg.status === 'error')) {
            // Check if this completed message ID is different from the last one saved
             if (msg.id && msg.id !== lastSavedMessageId) {
                 messageToSave = msg; 
             } 
             // Stop searching once we find the latest completed/errored assistant message
             break; 
        }
    }

    //console.log(`[useEffect Save Check] Found message to potentially save: ${messageToSave?.id}, lastSaved: ${lastSavedMessageId}, activeChatId: ${activeChatId}`);

    // If we found a completed assistant message that hasn't been saved
    if (messageToSave) {
        console.log(`[useEffect Save] Conditions MET for message ${messageToSave.id}. Calling saveCurrentChat with current activeChatId: ${activeChatId}`);
        // Pass the current messages state and activeChatId to the save function
        saveCurrentChat(messages, activeChatId); 
        // Update the tracker immediately *after* initiating the save
        setLastSavedMessageId(messageToSave.id);
    }
  }, [messages, activeChatId, lastSavedMessageId, initialLoadComplete, saveCurrentChat]);

  return (
    <div className="flex flex-row h-screen bg-gray-900">
      {/* --- Chat List Sidebar --- */}
      <ChatListSidebar 
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
      />

      {/* --- Main Chat Area (takes remaining space) --- */}
      <div className="flex flex-col flex-1 h-screen">
        <header className="bg-user-message-bg shadow">
          <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
            <h1 className="text-2xl text-white">
              groq<span className="text-primary">desktop</span>
            </h1>
            <div className="flex items-center gap-4">
              <div className="flex items-center">
                <label htmlFor="model-select" className="mr-3 text-gray-300 font-medium">Model:</label>
                <select
                  id="model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="border border-gray-500 rounded-md bg-transparent text-white"
                >
                  {models.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center">
                <label htmlFor="platform-select" className="mr-3 text-gray-300 font-medium">Platform:</label>
                <select
                  id="platform-select"
                  value={selectedPlatform}
                  onChange={(e) => handlePlatformChange(e.target.value)}
                  className="border border-gray-500 rounded-md bg-transparent text-white"
                >
                  <option value="groq">Groq</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </div>
              <Link to="/settings" className="btn btn-primary">Settings</Link>
            </div>
          </div>
        </header>
        
        <main className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-2">
            <MessageList 
              messages={messages} 
              onToolCallExecute={executeToolCall} 
              onRemoveLastMessage={handleRemoveLastMessage} 
            />
            <div ref={messagesEndRef} />
          </div>
          
          <div className="bg-user-message-bg p-2">
            <div className="flex flex-col gap-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="tools-container">
                    <div 
                      className="tools-button"
                      onClick={() => {
                        setIsToolsPanelOpen(!isToolsPanelOpen);
                        // Force refresh of MCP tools when opening panel
                        if (!isToolsPanelOpen) {
                          refreshMcpTools();
                        }
                      }}
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    {mcpServersStatus.loading && (
                      <div className="status-indicator loading">
                        <div className="loading-spinner"></div>
                        <span>{mcpServersStatus.message}</span>
                      </div>
                    )}
                    {!mcpServersStatus.loading && (
                      <div className="status-indicator">
                        <span>{mcpServersStatus.message || "No tools available"}</span>
                        <button 
                          className="refresh-button" 
                          onClick={refreshMcpTools}
                          title="Refresh MCP tools"
                        >
                          <span>↻</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {/* --- Model Pricing Display --- */}
                <div className="text-xs text-gray-400 text-right">
                    {currentModelInfo && currentModelInfo.prompt_cost_per_token !== null && currentModelInfo.completion_cost_per_token !== null ? (
                        <span>
                           {/* Display pricing per Million tokens by multiplying cost per token */}
                           Pricing: ${(currentModelInfo.prompt_cost_per_token * 1000000).toFixed(2)}/M Prompt | ${(currentModelInfo.completion_cost_per_token * 1000000).toFixed(2)}/M Completion
                        </span>
                    ) : selectedPlatform === 'openrouter' ? (
                        <span>Pricing info unavailable</span>
                    ) : (
                         <span>(Pricing N/A for Groq)</span>
                    )}
                </div>
                {/* --- End Model Pricing Display --- */}
              </div>

              <ChatInput
                ref={chatInputRef}
                onSendMessage={handleSendMessage}
                loading={loading}
                visionSupported={isVisionSupported}
                selectedPlatform={selectedPlatform}
              />
            </div>
          </div>
        </main>

        {isToolsPanelOpen && (
          <ToolsPanel
            tools={mcpTools}
            onClose={() => setIsToolsPanelOpen(false)}
            onDisconnectServer={disconnectMcpServer}
            onReconnectServer={reconnectMcpServer}
          />
        )}

        {/* --- Tool Approval Modal --- */}
        {pendingApprovalCall && (
          <ToolApprovalModal
            toolCall={pendingApprovalCall}
            onApprove={handleToolApproval}
          />
        )}
        {/* --- End Tool Approval Modal --- */}
      </div>
    </div>
  );
}

export default App; 