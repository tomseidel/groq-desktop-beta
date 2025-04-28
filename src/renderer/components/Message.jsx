import React, { useState } from 'react';
import ToolCall from './ToolCall';
import { useChat } from '../context/ChatContext';
import MarkdownRenderer from './MarkdownRenderer';

function Message({ message, children, onToolCallExecute, allMessages, isLastMessage, onRemoveMessage, originalIndex, onEditMessage, onSaveEdit }) {
  const { role, tool_calls, reasoning, isStreaming, status, id: messageId, content, finalContent } = message;
  const [showReasoning, setShowReasoning] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const { thinkingSteps } = useChat();
  const isUser = role === 'user';
  const hasReasoning = reasoning && !isUser;
  const isStreamingMessage = isStreaming === true;

  const currentThinkingSteps = thinkingSteps[messageId] || {};
  const thinkingStepIds = Object.keys(currentThinkingSteps);

  // Find tool results for this message's tool calls in the messages array
  const findToolResult = (toolCallId) => {
    if (!allMessages) return null;
    
    // Look for a tool message that matches this tool call ID
    const toolMessage = allMessages.find(
      msg => msg.role === 'tool' && msg.tool_call_id === toolCallId
    );
    
    return toolMessage ? toolMessage.content : null;
  };

  const messageClasses = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
  // Apply background only for user messages
  const bubbleStyle = isUser ? 'bg-user-message-bg' : ''; // No background for assistant/system
  const bubbleClasses = `relative px-4 py-3 rounded-lg max-w-xl ${bubbleStyle} group`; // Added group for remove button
  const wrapperClasses = `message-content-wrapper ${isUser ? 'text-white' : 'text-white'} break-words`; // Keep text white for both, use break-words

  const toggleReasoning = () => setShowReasoning(!showReasoning);

  // Function to extract plain text content for editing
  const getPlainTextContent = (msgContent) => {
      if (Array.isArray(msgContent)) {
          const textPart = msgContent.find(part => part.type === 'text');
          return textPart ? textPart.text : '';
      } else if (typeof msgContent === 'string') {
          return msgContent;
      }
      return ''; // Default empty string if no text found
  };

  const handleEditClick = () => {
      setEditedContent(getPlainTextContent(content)); // Initialize with current text
      setIsEditing(true);
  };

  const handleCancelClick = () => {
      setIsEditing(false);
      setEditedContent(''); // Clear edited content
  };

  const handleSaveClick = () => {
      // Basic validation: Don't save if empty
      if (editedContent.trim() === '') {
          // Optionally show an error or just cancel
          handleCancelClick();
          return;
      }
      // Call the save handler passed from parent (App.jsx) using originalIndex
      onSaveEdit(originalIndex, editedContent);
      setIsEditing(false); // Exit editing mode after calling save
  };

  return (
    <div className={messageClasses}>
      {/* --- Tool Message Rendering --- */} 
      {role === 'tool' ? (
          <div className={`${bubbleClasses} bg-gray-700 border border-gray-600 max-w-md`}> {/* Specific style for tool result */} 
               <div className="text-xs font-semibold text-purple-300 mb-1">Tool Result: {message.name || 'Unknown Tool'}</div>
               <pre className="text-xs whitespace-pre-wrap break-words text-gray-200">{message.content || '(No content returned)'}</pre>
          </div>
      ) : (
        /* --- Regular User/Assistant Message Rendering --- */
        <div className={bubbleClasses}>
             {isLastMessage && onRemoveMessage && (
                <button 
                    onClick={onRemoveMessage}
                    className={`absolute ${isUser ? 'right-1' : 'left-1'} top-0 -translate-y-1/2 bg-red-500 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 hover:bg-red-600 z-10`}
                    title="Remove message"
                >
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                     </svg>
                </button>
             )}
             {/* Edit button for user messages - updated onClick */} 
             {isUser && onSaveEdit && (
                  <button
                      onClick={handleEditClick} // Use local handler
                      className={`absolute right-10 top-0 -translate-y-1/2 bg-blue-500 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 hover:bg-blue-600 z-10 ${isEditing ? 'hidden' : ''}`} // Hide button when editing
                      title="Edit message"
                  >
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                  </button>
             )}
            {/* Render Initial Content OR Editing UI */}
            {isEditing ? (
                // --- Editing UI --- 
                <div className="flex flex-col gap-2 w-full">
                     <textarea
                         value={editedContent}
                         onChange={(e) => setEditedContent(e.target.value)}
                         className="w-full p-2 rounded-md bg-gray-600 text-white placeholder-gray-400 resize-y border border-gray-500 focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px]"
                         rows={3} // Adjust rows as needed
                         // Auto-focus might be desirable, but handle carefully
                         // autoFocus 
                     />
                     <div className="flex justify-end gap-2">
                         <button
                             onClick={handleCancelClick}
                             className="px-3 py-1 rounded-md bg-gray-500 hover:bg-gray-400 text-white text-sm"
                         >
                             Cancel
                         </button>
                         <button
                             onClick={handleSaveClick}
                             className="px-3 py-1 rounded-md bg-primary hover:bg-primary-dark text-white text-sm"
                         >
                             Save & Submit
                         </button>
                     </div>
                </div>
                // --- End Editing UI ---
            ) : (
                // --- Original Content Rendering --- 
                <div className={wrapperClasses}>
                  {children} {/* Render content passed from MessageList */} 
                  {/* Show streaming dots for initial text, *not* when processing tools */}
                   {role === 'assistant' && isStreamingMessage && status === 'streaming_text' && (
                    <div className="streaming-indicator ml-1 inline-block">
                      <span className="dot-1"></span>
                      <span className="dot-2"></span>
                      <span className="dot-3"></span>
                    </div>
                  )}
                </div>
            )}
            
            {/* --- Thinking Steps Visualization --- */} 
            {/* Show EITHER live thinking steps OR historical tool calls */} 
            {!isEditing && role === 'assistant' && thinkingStepIds.length > 0 && (
                 // Existing Live Thinking Steps Rendering based on thinkingSteps state
                 <div className="thinking-steps-container mt-2 border-t border-gray-600 pt-2 space-y-2">
                     {thinkingStepIds.map((callId) => {
                         const step = currentThinkingSteps[callId];
                         if (!step) return null; 
                         
                         let argsString = "(No args)";
                         if (step.args && typeof step.args === 'object' && Object.keys(step.args).length > 0) {
                             try {
                                 argsString = JSON.stringify(step.args, null, 2);
                             } catch { argsString = "(Invalid args)"; }
                         } else if (typeof step.args === 'string') {
                             argsString = step.args;
                         }

                         let resultDisplay = step.result;
                         if (typeof step.result === 'string' && step.result.trim().startsWith('{') && step.result.trim().endsWith('}')) {
                             try {
                                 const parsedResult = JSON.parse(step.result);
                                 resultDisplay = (
                                     <pre className="text-xs whitespace-pre-wrap break-words">
                                         {JSON.stringify(parsedResult, null, 2)}
                                     </pre>
                                 );
                             } catch { /* Ignore */ }
                         }
                         
                         return (
                             <div key={callId} className="tool-step p-2 bg-gray-700 bg-opacity-50 rounded text-sm border border-gray-500">
                                <div className="flex items-center gap-2 font-medium text-gray-300">
                                    {step.status === 'executing' && (
                                        <svg className="animate-spin h-4 w-4 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    )}
                                    {step.status === 'complete' && <span className="text-green-400">✓</span>}
                                    {step.status === 'error' && <span className="text-red-400">✗</span>}
                                    <span>{step.name || 'Unknown Tool'}</span>
                                </div>
                                <details className="mt-1 ml-6 cursor-pointer">
                                    <summary className="text-xs text-gray-400 hover:text-gray-200 outline-none focus:outline-none">Arguments</summary>
                                    <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-gray-800 p-1 rounded">{argsString}</pre>
                                </details>
                                {step.status === 'complete' && step.result != null && (
                                    <details className="mt-1 ml-6 cursor-pointer">
                                        <summary className="text-xs text-gray-400 hover:text-gray-200 outline-none focus:outline-none">Result</summary>
                                        <div className="mt-1 text-xs bg-gray-800 p-1 rounded">{resultDisplay}</div>
                                    </details>
                                )}
                                {step.status === 'error' && step.error && (
                                    <details className="mt-1 ml-6 cursor-pointer" open> { /* Open error details by default */}
                                        <summary className="text-xs text-red-400 hover:text-red-200 outline-none focus:outline-none">Error</summary>
                                        <div className="mt-1 text-xs text-red-300 bg-red-900 bg-opacity-30 p-1 rounded">{step.error}</div>
                                    </details>
                                )}
                            </div>
                        );
                     })}
                 </div>
            )}
            {/* --- Historical Tool Call Display --- */} 
            {!isEditing && role === 'assistant' && thinkingStepIds.length === 0 && tool_calls && tool_calls.length > 0 && (
                 <div className="historical-tool-steps-container mt-2 border-t border-gray-600 pt-2 space-y-2">
                     {tool_calls.map((toolCall, index) => {
                         const toolResultContent = findToolResult(toolCall.id); // Find the saved result
                         let resultIsError = false;
                         let errorDisplay = null;
                         let resultDisplay = toolResultContent;
                         let argsString = "(No args)";

                         // Parse Args
                         try {
                             if (toolCall.function?.arguments) {
                                 const parsedArgs = JSON.parse(toolCall.function.arguments);
                                 argsString = JSON.stringify(parsedArgs, null, 2);
                             } 
                         } catch { argsString = toolCall.function?.arguments || "(Invalid JSON args)"; }

                         // Check if result content indicates an error
                         if (typeof toolResultContent === 'string') {
                             if (toolResultContent.startsWith('Error:') || toolResultContent.includes('error')) { // Basic check
                                 resultIsError = true;
                                 errorDisplay = toolResultContent;
                             } else if (toolResultContent.trim().startsWith('{') && toolResultContent.trim().endsWith('}')) {
                                // Try to parse JSON result for better display
                                 try {
                                     const parsedResult = JSON.parse(toolResultContent);
                                     // Check for explicit error property common in tool results
                                     if (parsedResult.error) {
                                         resultIsError = true;
                                         errorDisplay = JSON.stringify(parsedResult.error, null, 2);
                                     } else {
                                         resultDisplay = (
                                             <pre className="text-xs whitespace-pre-wrap break-words">
                                                 {JSON.stringify(parsedResult, null, 2)}
                                             </pre>
                                         );
                                     }
                                 } catch { /* Ignore parsing error, display as string */ }
                             }
                         }
                         
                         return (
                             <div key={toolCall.id || index} className="tool-step p-2 bg-gray-700 bg-opacity-50 rounded text-sm border border-gray-500">
                                <div className="flex items-center gap-2 font-medium text-gray-300">
                                    {resultIsError ? (
                                         <span className="text-red-400">✗</span>
                                    ) : (
                                        <span className="text-green-400">✓</span>
                                    )}
                                    <span>{toolCall.function?.name || 'Unknown Tool'}</span>
                                 </div>
                                <details className="mt-1 ml-6 cursor-pointer">
                                    <summary className="text-xs text-gray-400 hover:text-gray-200 outline-none focus:outline-none">Arguments</summary>
                                    <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-gray-800 p-1 rounded">{argsString}</pre>
                                 </details>
                                {resultIsError ? (
                                    <details className="mt-1 ml-6 cursor-pointer" open>
                                         <summary className="text-xs text-red-400 hover:text-red-200 outline-none focus:outline-none">Error</summary>
                                         <div className="mt-1 text-xs text-red-300 bg-red-900 bg-opacity-30 p-1 rounded">{errorDisplay}</div>
                                    </details>
                                ) : (
                                    <details className="mt-1 ml-6 cursor-pointer">
                                        <summary className="text-xs text-gray-400 hover:text-gray-200 outline-none focus:outline-none">Result</summary>
                                        <div className="mt-1 text-xs bg-gray-800 p-1 rounded">{resultDisplay ?? '(No result content)'}</div>
                                    </details>
                                )}
                             </div>
                         );
                     })}
                 </div>
            )}
            {/* --- End Thinking/Historical Steps --- */}

            {/* Render Final Content (Only for Assistant messages and NOT editing) */} 
             {!isEditing && role === 'assistant' && (finalContent || status === 'streaming_final_response') && (
                <div className={`${wrapperClasses} mt-2 pt-2 border-t border-gray-600`}>
                     <MarkdownRenderer content={finalContent || ''} />
                     {role === 'assistant' && isStreamingMessage && status === 'streaming_final_response' && ( 
                         <div className="streaming-indicator ml-1 inline-block">
                           <span className="dot-1"></span>
                           <span className="dot-2"></span>
                           <span className="dot-3"></span>
                         </div>
                     )}
                </div>
             )}

            {/* Reasoning Section (Only show if NOT editing) */} 
             {!isEditing && hasReasoning && (
              <div className="mt-3 border-t border-gray-600 pt-2">
                <button 
                  onClick={toggleReasoning}
                  className="flex items-center text-sm px-3 py-1 rounded-md bg-gray-600 hover:bg-gray-500 transition-colors duration-200"
                >
                  <svg 
                    xmlns="http://www.w3.org/2000/svg" 
                    className={`h-4 w-4 mr-1 transition-transform duration-200 ${showReasoning ? 'rotate-90' : ''}`} 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
                </button>
                
                {showReasoning && (
                  <div className="mt-2 p-3 bg-gray-800 rounded-md text-sm border border-gray-600">
                    <pre className="whitespace-pre-wrap break-words">{reasoning}</pre>
                  </div>
                )}
              </div>
             )}
        </div>
      )}
    </div>
  );
}

export default Message; 