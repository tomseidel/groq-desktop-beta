 # Plan: Implementing File & Image Attachments in Groq Desktop

This document outlines the plan to add file and image attachment capabilities to the Groq Desktop chat interface.

## Phase 1: Frontend UI for Attachments

**Goal:** Allow users to select files/images and see them attached to the chat input area before sending.

*   **Task 1.1: Modify Chat Input Component:**
    *   Identify the primary chat input component (likely within `src/renderer/components/`).
    *   Add a file input button (`<input type="file">` styled appropriately) and potentially enable drag-and-drop functionality onto the input area.
    *   Allow selection of multiple files and common image types (jpg, png, gif, webp) initially. Maybe restrict other file types for now.
*   **Task 1.2: Display Attachments:**
    *   Create a new UI section below the text input to display previews or icons of the attached files/images.
    *   For images, show thumbnails. For other files, show an icon and filename.
*   **Task 1.3: Removal Functionality:**
    *   Add a button (e.g., 'x') next to each attached item preview to allow users to remove it before sending.
*   **Task 1.4: Update Send Logic:**
    *   Modify the existing message sending function (triggered by send button or Enter key).
    *   Gather information about the attached files (e.g., file path, name, type, size; potentially base64 encode small images).
    *   Send this attachment information along with the text message via IPC to the main process.

## Phase 2: Backend Handling & Basic Processing

**Goal:** Receive attachment information in the main process and prepare it for API interaction.

*   **Task 2.1: Update IPC Handling:**
    *   Modify the IPC listeners in `electron/main.js` (and potentially `electron/chatHandler.js`) to receive the attachment data sent from the renderer.
    *   Ensure `electron/preload.js` exposes the necessary IPC channels securely.
*   **Task 2.2: Attachment Processing in `chatHandler.js`:**
    *   Receive the file metadata (paths, types) in `electron/chatHandler.js`.
    *   **Decision Point:** How to handle file content?
        *   *Option A (Simpler Start):* Initially, just pass file *metadata* (like filename) to the LLM context, perhaps mentioning "[User attached file: filename.txt]". Actual content processing comes later.
        *   *Option B (More Complex):* Implement basic content reading. For images, store the path or base64 data. For text files, read the content. Define size limits.
    *   Consider security: Validate file paths received from the renderer process. Don't process arbitrary files without checks.
*   **Task 2.3: Data Structure for API:**
    *   Modify the data structure passed to the Groq API call function to include information about the attachments (metadata and potentially processed content/data).

## Phase 3: API Integration (Multimodal Input)

**Goal:** Adapt the API calls to include image data and potentially file content, leveraging model capabilities.

*   **Task 3.1: Research API Capabilities:**
    *   Investigate how the `groq-sdk` (and potentially alternative APIs like Gemini) supports multimodal input (specifically images). Does it accept image URLs, base64 data, or other formats?
    *   Determine how to best include text file content within the prompt structure.
*   **Task 3.2: Modify API Call Logic (`chatHandler.js`):**
    *   Update the function that makes the API call to format the request according to the specific model's requirements for multimodal input.
    *   This might involve adding image data to a specific field or structuring the prompt to include file content effectively.
*   **Task 3.3: Handle API Responses:**
    *   Ensure the frontend can correctly display responses that might refer to or analyze the attached content. No major changes expected here initially, but keep in mind.

## Phase 4: Advanced Features & Refinements

**Goal:** Enhance the attachment functionality with better UX, broader file support, and context management.

*   **Task 4.1: Context Window Management:**
    *   Address how large file content impacts the model's context window.
    *   Implement strategies: Summarization of large texts before sending, chunking, or explicitly warning the user if content exceeds limits.
*   **Task 4.2: Paste Image Support:**
    *   Add event listeners to the chat input to handle pasting image data directly from the clipboard.
*   **Task 4.3: Expanded File Type Support:**
    *   Integrate libraries (in the main process) to extract text content from files like PDFs, DOCX, etc. (e.g., `pdf-parse`, `mammoth`).
*   **Task 4.4: Chat History Display:**
    *   Modify the chat message display components (`src/renderer/components/`) to visually represent messages that included attachments (e.g., show image thumbnails or file icons alongside the text).
*   **Task 4.5: Error Handling & UX:**
    *   Improve error handling for file reading issues, API errors related to attachments, and unsupported file types.
    *   Add loading indicators for file processing or uploading steps if they become time-consuming.
