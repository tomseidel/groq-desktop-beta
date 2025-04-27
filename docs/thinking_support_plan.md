# Thinking Model & Streaming Tool Call Support - Phased Plan

## 1. Goal

Enhance Groq Desktop to visually represent the intermediate steps ("thinking") of Large Language Models when they utilize tools (function calling). This involves handling streaming tool call instructions from OpenAI-compatible APIs (Groq, OpenRouter), executing the tools via existing MCP handlers, and displaying the process in the chat interface.

## Phase 1: Backend - Tool Call Detection & Handling (No UI Changes)

**Focus:** Implement the core logic in `chatHandler.js` to detect tool calls in streams, execute them using `toolHandler.js`, and manage the two-step API call process. Testing primarily via console logs.

*   **Task 1.1 (`chatHandler.js`):** Implement state management within `handleChatStream` for `accumulatedContent`, `pendingToolCalls`, and `processedToolResults` per turn.
*   **Task 1.2 (`chatHandler.js`):** Adapt stream processing logic (`res.on('data')`) to correctly identify and accumulate text (`delta.content`) vs. tool call chunks (`delta.tool_calls`), populating the state variables from Task 1.1.
*   **Task 1.3 (`chatHandler.js`):** Implement logic for `finish_reason: 'tool_calls'` (or when tool calls are detected and stream ends):
    *   Finalize assembly of `pendingToolCalls` (ensure complete JSON args).
    *   Append the initial assistant message (with `tool_calls` array) to the *next* API call's history.
    *   Iterate through assembled tool calls.
    *   *For each tool call:* Call the existing `handleExecuteToolCall` function (requires importing it or adapting `chatHandler` to have access). Handle its async response (result/error).
    *   Format the tool execution outcome into a `role: "tool"` message object (with `tool_call_id`, `name`, `content`).
    *   Append all generated `role: "tool"` messages to the *next* API call's history.
    *   Initiate the *second* streaming API call using the updated message history.
    *   Process the stream from this second call (expected to contain final text response).
*   **Task 1.4 (`chatHandler.js`):** Ensure the logic correctly handles the case where `finish_reason: 'stop'` occurs in the *first* API call (no tool calls were made).
*   **Task 1.5 (`chatHandler.js`):** Update the `countTokensForMessages` function to accurately account for tokens in assistant messages with `tool_calls` and subsequent `role: "tool"` messages.
*   **Task 1.6 (Testing):** Add console logging to verify:
    *   Tool call chunks are correctly parsed and assembled.
    *   `handleExecuteToolCall` is invoked with correct arguments.
    *   `role: "tool"` messages are constructed correctly.
    *   The second API call is made with the correct history.
    *   The final response content is received.

## Phase 2: Frontend - Basic "Thinking" State & IPC

**Focus:** Connect the backend logic to the frontend with basic state management and IPC, showing a simple "Thinking..." indicator without detailed tool info yet.

*   **Task 2.1 (IPC):** Define and send new IPC messages from `chatHandler.js` during the tool execution loop:
    *   `tool-call-start` (sent *before* calling `handleExecuteToolCall`, includes `callId`, `name`, `args`).
    *   `tool-call-end` (sent *after* `handleExecuteToolCall` completes, includes `callId`, `result`, `error`).
    *   `turn-complete` (sent after the final response stream ends).
    *   Ensure `stream-chunk` is still sent for text parts.
*   **Task 2.2 (`App.jsx`/`ChatContext.jsx`):** Add new state variables:
    *   `thinkingSteps` (e.g., `{ [messageId]: { [callId]: { status: 'pending' | 'executing' | 'complete' | 'error' } } }` - just status for now).
    *   Enhance message state to include `status: 'streaming_text' | 'processing_tools' | 'streaming_final_response' | 'complete'`. Associate this status with the assistant message being processed.
*   **Task 2.3 (`App.jsx`/`ChatContext.jsx`):** Implement IPC listeners for the new messages (`tool-call-start`, `tool-call-end`, `turn-complete`) to update the state from Task 2.2. Update the message status accordingly.
*   **Task 2.4 (`ChatMessage.jsx`):**
    *   Read the message `status`.
    *   Conditionally render a simple, static "Thinking..." indicator (e.g., below the message text) if the status is `processing_tools`.
    *   Ensure text received via `stream-chunk` (both initial and final) still renders correctly.
*   **Task 2.5 (Testing):** Test the end-to-end flow: User sends message -> API calls tool -> Backend sends IPC -> Frontend shows "Thinking..." -> Backend executes tool -> Backend makes second call -> Backend sends final text -> Frontend displays final text and removes "Thinking...".

## Phase 3: Frontend - Detailed Tool Visualization

**Focus:** Enhance the UI to display detailed information about each tool call as it happens.

*   **Task 3.1 (`App.jsx`/`ChatContext.jsx`):** Enhance `thinkingSteps` state and IPC listeners (`tool-call-start`, `tool-call-end`) to store/update `name`, `args`, `result`, and `error` for each tool call.
*   **Task 3.2 (`ChatMessage.jsx`):** Implement the detailed rendering logic for the "Thinking" section:
    *   Iterate through the `thinkingSteps` for the current message.
    *   Display tool `name`.
    *   Display arguments (`args`), potentially in a collapsible/formatted way.
    *   Show a spinner/loading indicator when `status` is `executing`.
    *   Display the `result` (formatted nicely) or `error` message when `status` is `complete`/`error`.
*   **Task 3.3 (Styling):** Apply appropriate CSS styling to the new tool visualization elements.
*   **Task 3.4 (Testing):** Test with various scenarios:
    *   Single tool call.
    *   Multiple parallel tool calls (if the backend/model supports it).
    *   Tool calls with complex arguments/results.
    *   Tool execution errors.

## Phase 4: Refinement & Edge Cases

**Focus:** Improve robustness, handle errors gracefully, ensure persistence works, and perform final testing.

*   **Task 4.1 (`chatHandler.js`):** Implement robust error handling within the tool execution loop. If `handleExecuteToolCall` returns an error, ensure the `role: "tool"` message reflects this clearly.
*   **Task 4.2 (`ChatMessage.jsx`):** Ensure tool execution errors passed via `tool-call-end` are displayed clearly in the UI.
*   **Task 4.3 (Persistence):** Review and test chat saving/loading (`electron/main.js`, `ChatContext.jsx`). Ensure assistant messages containing `tool_calls` and subsequent `role: "tool"` messages are saved and loaded correctly to reconstruct the conversation history accurately.
*   **Task 4.4 (Optional):** Investigate and potentially implement an abort mechanism initiated from the frontend to stop ongoing API calls or tool executions.
*   **Task 4.5 (Testing):** Conduct thorough end-to-end testing across different models (Groq Llama 3.1/3.3, OpenAI/OpenRouter models supporting tools), platforms, and various tool use cases (including model generating text before/after tool calls).
