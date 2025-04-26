import React, { useState, useEffect } from 'react';
import Message from './Message';
import MarkdownRenderer from './MarkdownRenderer';
import { FileText, XCircle, FileCode, FileJson, File } from 'lucide-react';

// Simpler check just for the prefix
const fileContentPrefix = '[Content of file:';
const fileErrorPrefix = '[Error processing file:';

// --- Helper Function for File Icons ---
const getIconForFileType = (filename) => {
  if (!filename) return FileText; // Default icon
  const extension = filename.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'py':
    case 'java':
    case 'c':
    case 'cpp':
    case 'cs':
    case 'go':
    case 'rb':
    case 'php':
    case 'swift':
    case 'kt':
    case 'rs':
    case 'html':
    case 'css':
    case 'sh':
    case 'bat':
      return FileCode;
    case 'json':
      return FileJson;
    case 'md':
    case 'txt':
    case 'log':
    case 'csv':
      return FileText;
    case 'pdf':
    case 'doc':
    case 'docx':
      return File; // Use generic File icon for documents
    // Add cases for other specific types if needed (e.g., images, audio, etc.)
    default:
      return FileText; // Default icon for unknown/other types
  }
};
// --- End Helper Function ---

function MessageList({ messages = [], onToolCallExecute, onRemoveLastMessage }) {
  const [showRemoveButtonIndex, setShowRemoveButtonIndex] = useState(null);
  const [fullScreenImage, setFullScreenImage] = useState(null);

  // Effect to handle Escape key for closing fullscreen image
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setFullScreenImage(null);
      }
    };

    // Only add listener if image is fullscreen
    if (fullScreenImage) {
      document.addEventListener('keydown', handleKeyDown);
    }

    // Cleanup function to remove listener
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [fullScreenImage]); // Dependency array includes fullScreenImage

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <p className="text-center max-w-md">
          Send a message to start a conversation with Groq
        </p>
      </div>
    );
  }

  // We still filter tool messages here because the `Message` component handles displaying
  // assistant messages and their corresponding tool calls/results.
  const displayMessages = messages.filter(message => message.role !== 'tool');

  return (
    <div className="space-y-2 pt-4">
      {displayMessages.map((message, index) => (
        <Message 
          key={index} 
          message={message} 
          onToolCallExecute={onToolCallExecute}
          allMessages={messages} // Pass all messages for the Message component to find tool results
          isLastMessage={index === displayMessages.length - 1}
          onRemoveMessage={index === displayMessages.length - 1 ? onRemoveLastMessage : null}
        >
          {message.role === 'user' ? (
            <div 
              className="flex items-start gap-2"
              onMouseEnter={() => index === displayMessages.length - 1 && onRemoveLastMessage && setShowRemoveButtonIndex(index)}
              onMouseLeave={() => setShowRemoveButtonIndex(null)}
            >
              <div className="flex-1 flex flex-col gap-2"> {/* Use flex-col for text/images */}
                {/* Check if content is an array (structured) or string (simple text) */}
                {Array.isArray(message.content) ? (
                  message.content.map((part, partIndex) => {
                    // --- Handle different content part types ---
                    if (part.type === 'file_content') {
                      const IconComponent = getIconForFileType(part.name);
                      return (
                        <div 
                          key={`file-content-${partIndex}`}
                          className="flex items-center gap-2 p-2 bg-gray-700 rounded-md border border-gray-600 text-sm text-gray-300 self-start"
                          title={`Content from ${part.name} was included in the prompt`}
                        >
                          <IconComponent size={18} className="flex-shrink-0" />
                          <span>{part.name} (Content used in prompt)</span>
                        </div>
                      );
                    } else if (part.type === 'file_error') {
                      const IconComponent = getIconForFileType(part.name);
                      return (
                        <div 
                          key={`file-error-${partIndex}`}
                          className="flex items-center gap-2 p-2 bg-red-900 bg-opacity-50 rounded-md border border-red-700 text-sm text-red-400 self-start"
                          title={`Error processing ${part.name}: ${part.error || 'Unknown error'}`}
                        >
                          <XCircle size={18} className="flex-shrink-0" />
                          <span>{part.name}: {part.error || 'Extraction failed'}</span>
                        </div>
                      );
                    } else if (part.type === 'text') {
                      // Check for attached file content/error marker (saved state)
                      const textContent = part.text || '';
                      const isFileContent = textContent.startsWith(fileContentPrefix);
                      const isFileError = textContent.startsWith(fileErrorPrefix);
                      
                      console.log(`[MessageList] Checking text part: "${textContent.substring(0, 50)}...", isFileContent: ${isFileContent}, isFileError: ${isFileError}`);

                      if (isFileContent || isFileError) {
                        let filename = 'unknown file';
                        let errorDetail = '';
                        const closingBracketIndex = textContent.indexOf(']');
                        if (closingBracketIndex !== -1) {
                            const prefixToRemove = isFileError ? fileErrorPrefix : fileContentPrefix;
                            // Extract text between prefix and closing bracket
                            let nameAndError = textContent.substring(prefixToRemove.length, closingBracketIndex);
                            // Check if there's an error detail part (e.g., "filename: error message")
                            const errorSeparatorIndex = nameAndError.indexOf(': ');
                            if (isFileError && errorSeparatorIndex !== -1) {
                                filename = nameAndError.substring(0, errorSeparatorIndex);
                                errorDetail = nameAndError.substring(errorSeparatorIndex + 2);
                            } else {
                                filename = nameAndError; // Assume the whole part is the filename if no error separator
                            }
                        }

                        const IconComponent = getIconForFileType(filename);

                        if (isFileError) {
                            // Render error placeholder
                            return (
                                <div 
                                  key={`file-text-error-${partIndex}`}
                                  className="flex items-center gap-2 p-2 bg-red-900 bg-opacity-50 rounded-md border border-red-700 text-sm text-red-400 self-start"
                                  title={`Error processing ${filename}: ${errorDetail || 'Unknown error'}`}
                                >
                                  <XCircle size={18} className="flex-shrink-0" />
                                  <span>{filename}: Error processing file</span>
                                </div>
                              );
                        } else {
                            // Render success placeholder (content used)
                            return (
                              <div 
                                key={`file-text-${partIndex}`}
                                className="flex items-center gap-2 p-2 bg-gray-700 rounded-md border border-gray-600 text-sm text-gray-300 self-start"
                                title={`Content from ${filename} was included in the prompt`}
                              >
                                <IconComponent size={18} className="flex-shrink-0" />
                                <span>{filename} (Content used in prompt)</span>
                              </div>
                            );
                        }
                      } else {
                        // Render normal text using MarkdownRenderer
                        // Remove previous logging here if desired, or keep for debugging other text
                        // console.log(`[MessageList] Checking text part:`, part.text?.substring(0, 100)); 
                        // console.log(`[MessageList] Regex match result: null`); 
                        return <MarkdownRenderer key={`text-${partIndex}`} content={textContent} />;
                      }
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                      // Render image preview
                      return (
                        <img
                          key={`image-${partIndex}`}
                          src={part.image_url.url} // Assumes base64 data URL
                          alt={`Uploaded image ${partIndex + 1}`}
                          className="max-w-xs max-h-48 rounded-md cursor-pointer self-start" // Align images left
                          onClick={() => setFullScreenImage(part.image_url.url)} // Show fullscreen on click
                        />
                      );
                    }
                    return null; // Should not happen with current structure
                  })
                ) : (
                  // If content is just a string, render it directly (shouldn't contain file content anymore, but handle just in case)
                  <MarkdownRenderer content={message.content || ''} />
                )}
              </div>
            </div>
          ) : message.role === 'assistant' ? (
            <MarkdownRenderer content={message.content || ''} />
          ) : null}
        </Message>
      ))}

      {/* Fullscreen Image Overlay */}
      {fullScreenImage && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4 cursor-pointer"
          onClick={() => setFullScreenImage(null)} // Dismiss on click outside image
        >
          <img 
            src={fullScreenImage} 
            alt="Fullscreen view" 
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking the image itself
          />
        </div>
      )}
    </div>
  );
}

export default MessageList; 