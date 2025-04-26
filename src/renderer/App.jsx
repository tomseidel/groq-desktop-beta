import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ToolsPanel from './components/ToolsPanel';
import ToolApprovalModal from './components/ToolApprovalModal';
import { useChat } from './context/ChatContext'; // Import useChat hook
// Import shared model definitions - REMOVED
// import { MODEL_CONTEXT_SIZES } from '../../shared/models';


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
  // const [messages, setMessages] = useState([]); // Remove local state
  const { messages, setMessages } = useChat(); // Use context state
  const [loading, setLoading] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('groq'); // 'groq' or 'openrouter'
  const [selectedModel, setSelectedModel] = useState(''); // Model ID for the selected platform
  const [mcpTools, setMcpTools] = useState([]);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [mcpServersStatus, setMcpServersStatus] = useState({ loading: false, message: "" });
  const messagesEndRef = useRef(null);
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

  // --- Function to load models for a specific platform ---
  const loadModelsForPlatform = async (platform) => {
      setLoading(true);
      console.log(`Requesting models for platform: ${platform}`);
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
        console.log(`Attempting to save selected model: ${selectedModel}`); // Debug log
        const settings = await window.electron.getSettings();
        // Check if the model actually changed before saving
        if (settings.model !== selectedModel) {
            console.log(`Saving new model selection: ${selectedModel}`);
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
      console.log(`Tool call response: ${JSON.stringify(response)}`);
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
    let currentTurnStatus = 'processing'; // processing, completed, paused, error
    let turnAssistantMessage = null;
    let turnToolResponses = [];

    try {
        // Create a streaming assistant message placeholder
        const assistantPlaceholder = {
            role: 'assistant',
            content: '',
            isStreaming: true
        };
        setMessages(prev => [...prev, assistantPlaceholder]);

        // Start streaming chat
        const streamHandler = window.electron.startChatStream(turnMessages, selectedModel);

        // Collect the final message data
        let finalAssistantData = {
            role: 'assistant',
            content: '',
            tool_calls: undefined,
            reasoning: undefined
        };

        // Setup event handlers for streaming
        streamHandler.onStart(() => { /* Placeholder exists */ });

        streamHandler.onContent(({ content }) => {
            finalAssistantData.content += content;
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { ...newMessages[idx], content: finalAssistantData.content };
                }
                return newMessages;
            });
        });

        streamHandler.onToolCalls(({ tool_calls }) => {
            finalAssistantData.tool_calls = tool_calls;
            setMessages(prev => {
                 const newMessages = [...prev];
                 const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                 if (idx !== -1) {
                     newMessages[idx] = { ...newMessages[idx], tool_calls: finalAssistantData.tool_calls };
                 }
                 return newMessages;
            });
        });

        // Handle stream completion
        await new Promise((resolve, reject) => {
            streamHandler.onComplete((data) => {
                finalAssistantData = {
                    role: 'assistant',
                    content: data.content || '',
                    tool_calls: data.tool_calls,
                    reasoning: data.reasoning
                };
                turnAssistantMessage = finalAssistantData; // Store the completed message

                setMessages(prev => {
                    const newMessages = [...prev];
                    const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                    if (idx !== -1) {
                        newMessages[idx] = finalAssistantData; // Replace placeholder
                    } else {
                         // Should not happen if placeholder logic is correct
                         console.warn("Streaming placeholder not found for replacement.");
                         newMessages.push(finalAssistantData);
                    }
                    return newMessages;
                });
                resolve();
            });

            streamHandler.onError(({ error }) => {
                console.error('Stream error:', error);
                // Replace placeholder with error
                setMessages(prev => {
                   const newMessages = [...prev];
                   const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                   const errorMsg = { role: 'assistant', content: `Stream Error: ${error}`, isStreaming: false };
                   if (idx !== -1) {
                       newMessages[idx] = errorMsg;
                   } else {
                       newMessages.push(errorMsg);
                   }
                   return newMessages;
                });
                reject(new Error(error));
            });
        });

        // Clean up stream handlers
        streamHandler.cleanup();

        // Check and process tool calls if any
        if (turnAssistantMessage && turnAssistantMessage.tool_calls?.length > 0) {
            // IMPORTANT: Pass the messages *before* this assistant message was added
            const { status: toolProcessingStatus, toolResponseMessages } = await processToolCalls(
                turnAssistantMessage,
                turnMessages // Pass the input messages for this turn
            );

            turnToolResponses = toolResponseMessages; // Store responses from this turn

            if (toolProcessingStatus === 'paused') {
                currentTurnStatus = 'paused'; // Signal pause to the caller
            } else if (toolProcessingStatus === 'completed') {
                 // If tools completed, the caller might loop
                 currentTurnStatus = 'completed_with_tools';
            } else { // Handle potential errors from processToolCalls if added
                currentTurnStatus = 'error';
            }
        } else {
             // No tools, this turn is complete
             currentTurnStatus = 'completed_no_tools';
        }

    } catch (error) {
      console.error('Error in executeChatTurn:', error);
      // Ensure placeholder is replaced or an error message is added
       setMessages(prev => {
           const newMessages = [...prev];
           const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
           const errorMsg = { role: 'assistant', content: `Error: ${error.message}`, isStreaming: false };
            if (idx !== -1) {
                newMessages[idx] = errorMsg;
            } else {
                // If streaming never started, add the error message
                newMessages.push(errorMsg);
            }
           return newMessages;
       });
      currentTurnStatus = 'error';
    }

    // Return the outcome of the turn
    return {
        status: currentTurnStatus, // 'completed_no_tools', 'completed_with_tools', 'paused', 'error'
        assistantMessage: turnAssistantMessage,
        toolResponseMessages: turnToolResponses,
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
    // Check if content is structured (array) or just text (string)
    const isStructuredContent = Array.isArray(content);
    const hasContent = isStructuredContent ? content.some(part => (part.type === 'text' && part.text.trim()) || part.type === 'image_url') : content.trim();

    if (!hasContent) return;

    // Format the user message based on content type
    const userMessage = {
      role: 'user',
      content: content // Assumes ChatInput now sends the correct structured format
    };
    // Add user message optimistically BEFORE the API call
    const initialMessages = [...messages, userMessage];
    setMessages(initialMessages);

    setLoading(true);

    let currentApiMessages = initialMessages; // Start with messages including the new user one
    let conversationStatus = 'processing'; // Start the conversation flow

    try {
        while (conversationStatus === 'processing' || conversationStatus === 'completed_with_tools') {
            const { status, assistantMessage, toolResponseMessages } = await executeChatTurn(currentApiMessages);

            conversationStatus = status; // Update status for loop condition

            if (status === 'paused') {
                 // Pause initiated by executeChatTurn/processToolCalls
                 // Loading state remains true, waiting for modal interaction
                 break; // Exit the loop
            } else if (status === 'error') {
                 // Error occurred, stop the loop
                 break;
            } else if (status === 'completed_with_tools') {
                 // Prepare messages for the next turn ONLY if tools were completed
                 if (assistantMessage && toolResponseMessages.length > 0) {
                     // Format tool responses for the API
                     const formattedToolResponses = toolResponseMessages.map(msg => ({
                         role: 'tool',
                         content: msg.content, // Ensure this is a string
                         tool_call_id: msg.tool_call_id
                     }));
                     // Append assistant message and tool responses for the next API call
                     currentApiMessages = [
                         ...currentApiMessages,
                         { // Assistant message that included the tool calls
                            role: assistantMessage.role,
                            content: assistantMessage.content,
                            tool_calls: assistantMessage.tool_calls
                         },
                         ...formattedToolResponses
                     ];
                     // Loop continues as conversationStatus is 'completed_with_tools'
                 } else {
                     // Should not happen if status is completed_with_tools, but safety break
                     console.warn("Status 'completed_with_tools' but no assistant message or tool responses found.");
                     conversationStatus = 'error'; // Treat as error
                     break;
                 }
            } else if (status === 'completed_no_tools') {
                 // Conversation turn finished without tools, stop the loop
                 break;
            }
        } // End while loop

    } catch (error) {
        // Catch errors originating directly in handleSendMessage loop (unlikely with refactor)
        console.error('Error in handleSendMessage conversation flow:', error);
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error.message}` }]);
        conversationStatus = 'error'; // Ensure loading state is handled
    } finally {
        // Only set loading false if the conversation is not paused
        if (conversationStatus !== 'paused') {
            setLoading(false);
        }
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
             // Start the next turn
             const { status: nextTurnStatus } = await executeChatTurn(nextApiMessages);
             // If the *next* turn also pauses, loading state remains true
             if (nextTurnStatus !== 'paused') {
                 setLoading(false);
             }
        } catch (error) {
            console.error("Error during resumed chat turn:", error);
            setMessages(prev => [...prev, { role: 'assistant', content: `Error after resuming: ${error.message}` }]);
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

  return (
    <div className="flex flex-col h-screen">
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
            {/* Add Clear Chat Button */}
            <button 
              onClick={handleClearChat} 
              className="btn btn-secondary" // You might need to define btn-secondary styles
              title="Clear Chat History"
            >
              Clear Chat
            </button>
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
            </div>

            <ChatInput
              onSendMessage={handleSendMessage}
              loading={loading}
              visionSupported={isVisionSupported}
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
  );
}

export default App; 