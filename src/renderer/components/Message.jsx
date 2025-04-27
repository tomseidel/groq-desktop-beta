import React, { useState } from 'react';
import ToolCall from './ToolCall';
import { useChat } from '../context/ChatContext';
import MarkdownRenderer from './MarkdownRenderer';

function Message({ message, children, onToolCallExecute, allMessages, isLastMessage, onRemoveMessage }) {
  const { role, tool_calls, reasoning, isStreaming, status, id: messageId, content, finalContent } = message;
  const [showReasoning, setShowReasoning] = useState(false);
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
            {/* Render Initial Content (Passed as children from MessageList) */}
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
            
            {/* --- Thinking Steps Visualization --- */} 
            {/* Show EITHER live thinking steps OR historical tool calls */} 
            {role === 'assistant' && thinkingStepIds.length > 0 && (
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
            {role === 'assistant' && thinkingStepIds.length === 0 && tool_calls && tool_calls.length > 0 && (
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

            {/* Render Final Content (Only for Assistant messages) */} 
             {role === 'assistant' && (finalContent || status === 'streaming_final_response') && (
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

            {/* Reasoning Section (Keep as is) */} 
             {hasReasoning && (
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