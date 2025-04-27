import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { v4 as uuidv4 } from 'uuid'; // Import uuid
import { FileText, Image as ImageIcon, AlertCircle, Loader2, CheckCircle, XCircle } from 'lucide-react'; // Add icons

// Define Attachment Status constants
const STATUS_PENDING = 'pending';
const STATUS_EXTRACTING = 'extracting';
const STATUS_COMPLETE = 'complete';
const STATUS_ERROR = 'error';

// Wrap component with forwardRef
const ChatInput = forwardRef(({ onSendMessage, loading = false, visionSupported = false, selectedPlatform }, ref) => {
  const [message, setMessage] = useState('');
  // Updated attachments state structure
  const [attachments, setAttachments] = useState([]); 
  // Example structure: 
  // { id: 'uuid', name: 'file.pdf', type: 'application/pdf', size: 12345, 
  //   status: STATUS_PENDING | STATUS_EXTRACTING | STATUS_COMPLETE | STATUS_ERROR, 
  //   progress: 0, // Optional progress indicator
  //   extractedText: '...', // Populated on complete (if not image)
  //   errorMessage: '...', // Populated on error
  //   isImage: false, 
  //   base64: null // For image previews
  // }
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const prevLoadingRef = useRef(loading);

  // Expose focus method via useImperativeHandle
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    }
  }));

  // Allowed file types (adjust as needed)
  const allowedFileTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'text/plain', 'text/markdown', 'application/pdf', 'application/json',
    'text/csv', 'text/x-log', // Common log extensions might vary
    'application/x-python-code', 'text/javascript', 'application/jsx', 
    'application/typescript', 'application/tsx', 
    'text/html', 'text/css', 
    'text/x-c', 'text/x-c++src', 'text/x-java-source', // Basic code types
    'application/x-shellscript'
  ].join(',');

  // --- IPC Listener for Extraction Status --- 
  useEffect(() => {
    const handleExtractionStatus = (event, { uniqueId, status, result, error, progress }) => {
      console.log(`[IPC Status Update] ID: ${uniqueId}, Status: ${status}, Error: ${error}, Progress: ${progress}`);
      setAttachments(prevAttachments =>
        prevAttachments.map(att => {
          if (att.id === uniqueId) {
            return {
              ...att,
              status: status,
              extractedText: status === STATUS_COMPLETE ? result : att.extractedText,
              errorMessage: status === STATUS_ERROR ? error : null,
              progress: progress !== undefined ? progress : att.progress, // Update progress if provided
            };
          }
          return att;
        })
      );
    };

    // Assuming preload script exposes ipcRenderer.on directly or via a wrapper
    // Replace 'ipcRenderer' with your actual exposed object if different (e.g., window.electron)
    const removeListener = window.electron?.onFileExtractionStatus?.(handleExtractionStatus);
    // Fallback if not exposed via dedicated function (less clean)
    // window.ipcRenderer?.on('file-extraction-status', handleExtractionStatus);

    // Cleanup
    return () => {
      if (removeListener) {
         removeListener();
      } else {
         // Fallback cleanup
         // window.ipcRenderer?.removeListener('file-extraction-status', handleExtractionStatus);
      }
    };
  }, []); // Empty dependency array means this runs once on mount
  // --- End IPC Listener ---

  // Function to process files (needs significant changes)
  const processFiles = (fileList) => {
    const files = Array.from(fileList);
    const currentAttachmentCount = attachments.length;
    const imageAlreadyAttached = attachments.some(att => att.isImage);

    let filesToAdd = [];
    let imageLimitReached = false;

    for (const file of files) {
        if (filesToAdd.length + currentAttachmentCount >= 5) {
             // General 5-attachment limit check
             break; 
        }
        
        const isImage = file.type.startsWith('image/');

        // Apply 1-image limit ONLY for Groq platform vision models
        if (selectedPlatform === 'groq' && visionSupported && isImage && imageAlreadyAttached) {
            // Trying to add a second image when vision model has 1-image limit
            imageLimitReached = true; // Mark that we skipped an image due to the limit
            continue; // Skip this image file
        } else if (selectedPlatform === 'groq' && visionSupported && isImage && !imageAlreadyAttached && filesToAdd.some(f => f.type.startsWith('image/'))) {
             // Prevent adding more than one image *within the same batch* if vision is supported
             imageLimitReached = true;
             continue; // Skip subsequent images in this batch
        }
        
        // If not skipped by vision limit, add the file to be processed
        filesToAdd.push(file);
    }

    // Alert if any images were skipped due to the vision limit
    if (imageLimitReached) {
        alert('Vision models support only one image per message. Additional images were not added.');
    }
    
    // Alert if the general 5-attachment limit was hit during selection
    if (files.length > filesToAdd.length && filesToAdd.length + currentAttachmentCount < 5) {
       // This implies some files were skipped but not *only* due to the 5-item limit (e.g. could be the image limit)
       // We already show the image limit alert if needed. Maybe a generic alert? 
       // Let's rely on the image limit alert for now.
    } else if (files.length > filesToAdd.length && filesToAdd.length + currentAttachmentCount >= 5) {
        // This means the loop broke specifically because of the 5 item limit
        alert(`You can only add ${5 - currentAttachmentCount} more files (max 5 total attachments). Some files were not added.`);
    }

    // Only process the files that passed the checks
    if (filesToAdd.length === 0) {
      return; // Nothing to process
    }

    const newAttachments = [];

    // Loop through files *that passed initial checks*
    for (const file of filesToAdd) {
        const uniqueId = uuidv4(); // Generate unique ID
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        // Simple check for common text types that we might read directly OR extract via backend
        const isTextBased = /(\.txt|\.md|\.js|\.jsx|\.ts|\.tsx|\.py|\.html|\.css|\.json|\.csv|\.log|\.sh|\.bat)$/i.test(file.name) || file.type.startsWith('text/');
        const MAX_TEXT_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1MB limit for frontend reading

        let attachmentData = {
            id: uniqueId,
            name: file.name,
            type: file.type,
            size: file.size,
            isImage: isImage,
            base64: null,
            extractedText: null,
            errorMessage: null,
            status: STATUS_PENDING, // Default to pending
            progress: 0,
        };

        if (isImage) {
            // --- Image Handling: Read base64 for preview --- 
            // Status will be set to complete/error within the promise
             newAttachments.push(new Promise((resolve) => {
                 const reader = new FileReader();
                 reader.onloadend = () => {
                     attachmentData.base64 = reader.result;
                     attachmentData.status = STATUS_COMPLETE; // Mark image as complete immediately
                     resolve(attachmentData);
                 };
                 reader.onerror = (err) => {
                     console.error("Error reading image file:", file.name, err);
                     attachmentData.status = STATUS_ERROR;
                     attachmentData.errorMessage = "Failed to read image data";
                     resolve(attachmentData); // Resolve with error state
                 };
                 reader.readAsDataURL(file);
             }));
             // --- End Image Handling ---
        } else {
            // --- Text/PDF/DOCX/Other Handling: Request backend extraction --- 
            // IMPORTANT: Relies on file.path being accessible in the renderer
            const filePath = file.path;
            if (filePath) {
                console.log(`Requesting backend extraction for ${file.name} (ID: ${uniqueId})`);
                window.electron.requestFileExtraction(filePath, uniqueId);
                // Add the attachment placeholder with pending status
                newAttachments.push(Promise.resolve(attachmentData)); // Resolve immediately with pending state
            } else {
                 console.warn(`File path not accessible for ${file.name}. Cannot request extraction.`);
                 alert(`Could not access the file path for ${file.name}. Attachment failed.`);
                 // Don't add this file if path is missing
                 newAttachments.push(Promise.resolve(null)); // Indicate failure to add
            }
            // --- End Text/PDF/DOCX Handling ---
        }
    }
    
    // Update state after processing all selected files
    Promise.all(newAttachments).then(resolvedAttachments => {
        const validNewAttachments = resolvedAttachments.filter(att => att !== null);
        if (validNewAttachments.length > 0) {
             setAttachments(prev => [...prev, ...validNewAttachments]);
        }
    });
  };

  // Modified handler to just call processFiles
  const handleFileChange = (e) => {
    if (e.target.files) {
      processFiles(e.target.files);
      // Reset file input value to allow selecting the same file again if needed
      e.target.value = '';
    }
  };

  // --- Handle Paste --- 
  const handlePaste = (e) => {
    const clipboardData = e.clipboardData;
    const items = clipboardData.items;
    let pastedFiles = [];

    // Check for image files in clipboard items
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          pastedFiles.push(file);
        }
      }
    }

    if (pastedFiles.length > 0) {
        // If images are found, prevent default text paste and process files
        e.preventDefault();
        console.log(`Pasted ${pastedFiles.length} files. Processing...`);
        processFiles(pastedFiles); // Use new file processing logic
    } else {
        // If no image files, allow default text pasting or handle text insertion manually
        // For simplicity here, we could just let the default happen for text,
        // but manual insertion gives more control if needed later.
        // Let's manually insert for better control:
        e.preventDefault();
        const text = clipboardData.getData('text/plain');
        if (text && textareaRef.current) {
             const start = textareaRef.current.selectionStart;
             const end = textareaRef.current.selectionEnd;
             const currentText = message;
             const newText = currentText.substring(0, start) + text + currentText.substring(end);
             setMessage(newText);
             // Optionally move cursor to end of pasted text
             // requestAnimationFrame ensures the update happens after state change
             requestAnimationFrame(() => {
                if (textareaRef.current) {
                     textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + text.length;
                }
            });
        }
    }
  };
  // --- End Handle Paste ---

  // --- Drag and Drop Handlers ---
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Basic check to prevent flickering when dragging over child elements
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
      setIsDragging(false);
    }
    // If leaving the window entirely
    if (!e.relatedTarget) {
         setIsDragging(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      if (attachments.length < 5) {
        processFiles(e.dataTransfer.files);
      }
      e.dataTransfer.clearData();
    }
  };
  // --- End Drag and Drop Handlers ---

  // Function to remove an attachment
  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  // Focus the textarea after component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  // Focus the textarea when loading changes from true to false (completion finished)
  useEffect(() => {
    // Check if loading just changed from true to false
    if (prevLoadingRef.current && !loading) {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
    // Update the ref with current loading state
    prevLoadingRef.current = loading;
  }, [loading]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const textContent = message.trim();
    const hasText = textContent.length > 0;
    const hasAttachments = attachments.length > 0;

    // Ensure extraction isn't pending before allowing send
    const isExtractionPending = attachments.some(att => att.status === STATUS_PENDING || att.status === STATUS_EXTRACTING);
    if ((hasText || hasAttachments) && !loading && !isExtractionPending) {
      let contentToSend = [];

      // Add attachments first
      attachments.forEach(att => {
        if (att.isImage && att.base64 && att.status === STATUS_COMPLETE) {
          contentToSend.push({
            type: 'image_url',
            image_url: { url: att.base64 } 
          });
        } else if (!att.isImage && att.status === STATUS_COMPLETE && att.extractedText) {
            // Send extracted content for completed files
            contentToSend.push({
                type: 'file_content', // New type for backend
                name: att.name,
                content: att.extractedText 
            });
        } else if (att.status === STATUS_ERROR) {
             // Send error info for failed files
             contentToSend.push({
                 type: 'file_error', // New type for backend
                 name: att.name,
                 error: att.errorMessage || 'Unknown extraction error'
             });
        } else if (!att.isImage && att.status !== STATUS_COMPLETE && att.status !== STATUS_ERROR){
             // Fallback for files that somehow didn't complete or error (e.g., non-text/pdf/docx initially)
             // Send basic metadata like before
             contentToSend.push({
                type: 'text',
                text: `[User attached file: ${att.name} (${att.type}, ${Math.round(att.size / 1024)} KB) - Content not processed]` 
             });
        }
        // Note: We skip attachments with status PENDING or EXTRACTING because disableSend should prevent this submit
      });

      // Add user's text message last, if present
      if (hasText) {
        contentToSend.push({ type: 'text', text: textContent });
      }
      
      // Ensure we always send *something* if there are attachments, even if text is empty
      if (contentToSend.length > 0) {
        onSendMessage(contentToSend);
        setMessage('');
        setAttachments([]); // Clear attachments after sending
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Calculate if adding more images should be disabled (Specific to Groq vision models)
  const disableImageAdding = selectedPlatform === 'groq' && visionSupported && attachments.some(att => att.isImage);
  // Calculate if send should be disabled (due to loading or pending extraction)
  const isExtractionPending = attachments.some(att => att.status === STATUS_PENDING || att.status === STATUS_EXTRACTING);
  const disableSend = loading || isExtractionPending || (!message.trim() && attachments.length === 0);

  return (
    <form 
      onSubmit={handleSubmit} 
      onDragOver={handleDragOver} // Add D&D handlers
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-col gap-2 p-2 border rounded-md ${isDragging ? 'border-primary border-dashed bg-gray-700/50' : 'border-transparent'}`}
      > {/* Add padding, border, and drag-over styles */}
      {/* Attachments Previews Area */}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-2 mb-2">
          <div className="flex justify-between items-center"> {/* Container for title and potential warning */} 
            <p className="text-sm font-medium text-gray-400">Attached Files ({attachments.length}):</p>
            {/* Show 1-image limit message if applicable (Groq specific) */}
            {selectedPlatform === 'groq' && visionSupported && attachments.some(att => att.isImage) && (
                <span className="text-xs text-yellow-400 flex items-center gap-1" title="The selected Groq model supports only one image input.">
                    <AlertCircle size={14} /> 1 Image Limit (Groq)
                </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 p-2 border border-gray-600 rounded-md max-h-40 overflow-y-auto"> {/* Added scroll */}
            {attachments.map((att, index) => (
              <div key={att.id || index} className="relative group p-1 bg-gray-700 rounded-md flex flex-col items-center text-center w-24"> {/* Use att.id as key */}
                {/* Image Preview or File Icon/Status */}
                {att.isImage ? (
                  <img
                    src={att.base64} // Assumes base64 is loaded for images
                    alt={`Preview ${att.name}`}
                    className="w-16 h-16 object-cover rounded-md mb-1"
                  />
                ) : (
                  <div className="w-16 h-16 flex items-center justify-center bg-gray-600 rounded-md mb-1 relative">
                    {/* Show Status Icon */}
                    {att.status === STATUS_PENDING && (
                        <FileText size={32} className="text-gray-400 opacity-50" />
                        // Optional: Add a pending indicator like three dots?
                    )}
                    {att.status === STATUS_EXTRACTING && (
                        <Loader2 size={32} className="text-blue-400 animate-spin" />
                        // Optional: Add progress bar if available: 
                        // <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-500" style={{ width: `${att.progress || 0}%` }}></div>
                    )}
                    {att.status === STATUS_COMPLETE && (
                        <CheckCircle size={32} className="text-green-400" />
                    )}
                    {att.status === STATUS_ERROR && (
                        <XCircle size={32} className="text-red-400" />
                    )}
                  </div>
                )}
                {/* Filename and Error Message */}
                <span 
                   className={`text-xs text-gray-300 truncate w-full px-1 ${att.status === STATUS_ERROR ? 'text-red-400' : ''}`}
                   title={att.status === STATUS_ERROR ? att.errorMessage : att.name}
                 >
                   {att.status === STATUS_ERROR ? (att.errorMessage || 'Error') : att.name}
                </span>
                {/* Remove Button */}
                <button
                  type="button"
                  onClick={() => removeAttachment(index)}
                  className="absolute top-0 right-0 m-1 bg-red-600 hover:bg-red-700 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Remove ${att.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input Row */}
      <div className="flex items-end gap-2"> {/* Changed items-start to items-end */}
        {/* File Upload Button - Show if fewer than 5 attachments */}
        {attachments.length < 5 && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`tools-button flex-shrink-0 ${disableImageAdding ? 'opacity-50 cursor-not-allowed' : ''}`} // Add disabled appearance
            title={disableImageAdding ? "Cannot add more images with this Groq model" : "Add Attachment (max 5)"}
            disabled={loading || disableImageAdding} // Disable button if image adding is restricted
          >
            {/* Simple Paperclip Icon */}
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
          </button>
        )}
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          // accept="image/*" // Replaced by allowedFileTypes
          accept={allowedFileTypes}
          multiple
          style={{ display: 'none' }}
          disabled={loading || attachments.length >= 5 || disableImageAdding} // Also disable hidden input if image adding is restricted
        />

        {/* Text Area & Send Button Container */}
        <div className="flex-1 flex items-end gap-2"> {/* Container for text area and send button */} 
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste} // Add paste handler
            placeholder="Type a message... (Shift+Enter for newline)"
            className="w-full block py-2 px-3 border border-gray-500 rounded-md focus:outline-none focus:ring-2 focus:ring-primary bg-transparent text-white placeholder-gray-400 resize-none overflow-hidden max-h-[200px]" // Adjusted padding/height potentially
            rows={1}
            disabled={loading}
          />
          {/* Send Button */}
          <button
            type="submit"
            className="py-2 px-4 bg-primary hover:bg-primary/90 text-white rounded transition-colors self-end flex-shrink-0" // Added flex-shrink-0
            disabled={disableSend} // Disable if no text and no attachments
          >
            {loading ? (
              <span>Sending...</span>
            ) : (
              <span>Send</span>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}); // Close forwardRef

export default ChatInput; 