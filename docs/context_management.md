# Context Management Strategies for Groq Desktop

## 1. Introduction

Effective management of chat history and context is critical for Large Language Model (LLM) applications like Groq Desktop. As conversations grow, especially with the inclusion of tool calls (which involve multiple message exchanges per interaction), the total number of tokens can quickly exceed the model's context window limit. This impacts performance, cost, and the LLM's ability to maintain conversational coherence.

This document outlines the current approach and proposes enhanced strategies for context management within Groq Desktop, drawing on best practices identified through research [[1]](https://verticalserve.medium.com/genai-managing-context-history-best-practices-a350e57cc25f), [[2]](https://community.openai.com/t/best-practices-for-chat-conversation-storage-and-context-optimization-with-openai-api-3-5-turbo/712166), [[3]](https://community.openai.com/t/how-to-manage-chat-history-effectively/1116419).

## 2. Current Approach (Based on Project Documentation)

Groq Desktop currently implements basic context management:

-   **Token Counting:** Uses `tiktoken` (`electron/chatHandler.js`) to calculate the token count of the message history before sending it to the LLM.
-   **Truncation:** Automatically removes the *oldest* messages (`electron/messageUtils.js`, likely) when the calculated token count exceeds the selected model's context limit.
-   **Tool Call Inclusion:** Persists and includes the full sequence of assistant requests (`tool_calls`) and tool responses (`role: "tool"`) in the chat history sent to the model.
-   **Image Data Stripping:** Removes image data from older messages to save tokens when applicable.

## 3. Challenges with Current Approach

-   **Loss of Early Context:** Simple truncation removes the beginning of the conversation, which might contain crucial setup information or context.
-   **Tool Call Bloat:** Each tool interaction adds at least two messages (request and result) to the history. Complex workflows with multiple tool calls significantly accelerate context window consumption.
-   **Lack of Summarization:** Potentially valuable information from older messages or completed tool interactions is lost entirely rather than being condensed.

## 4. Proposed Enhanced Strategies

Based on best practices, the following strategies could be implemented to improve context management:

### 4.1. Summarization Strategy

-   **Goal:** Condense older parts of the conversation or specific message types (like tool interactions) to retain key information using fewer tokens.
-   **Implementation:**
    -   When the token count approaches the limit (e.g., 80% of the context window), trigger a summarization process.
    -   Use a separate, potentially smaller/faster LLM call to summarize:
        -   A chunk of the *oldest* messages (e.g., the first N messages or messages exceeding the 80% threshold).
        -   Completed tool call sequences (the `tool_calls` request and the corresponding `role: "tool"` result).
    -   Replace the original messages/tool calls with a single "summary" message (e.g., `role: "system", content: "Summary of earlier conversation: <summary text>"` or `role: "system", content: "Summary of previous tool interaction (<tool_name>): <summary text>"`).
    -   **Consideration:** Requires additional LLM calls for summarization, adding latency and potential cost, but preserving context more effectively than simple truncation.

### 4.2. Advanced Truncation ("Windowing" or "Middle-Out")

-   **Goal:** Preserve the beginning and end of the conversation, assuming the initial messages and the most recent exchanges are most important.
-   **Implementation:**
    -   When truncation is needed, keep the first message (often the system prompt or initial user query) and the N most recent messages.
    -   Remove messages from the *middle* of the conversation history.
    -   **Variation:** Could keep the first message, the last N messages, *and* a summary of the middle section (combining with 4.1).
-   **Reference:** Discussed as an alternative strategy in community forums [[3]](https://community.openai.com/t/how-to-manage-chat-history-effectively/1116419).

### 4.3. Selective Context Inclusion

-   **Goal:** Dynamically choose which parts of the history are most relevant, potentially prioritizing recent messages and summaries over full historical detail.
-   **Implementation:**
    -   Always include the system prompt (if any) and the N most recent messages.
    -   Include summaries of older conversation parts or tool calls (as generated in 4.1).
    -   Potentially filter out intermediate "thinking" steps or less critical exchanges if fine-grained control is desired (more complex).

### 4.4. Token Count Awareness and Thresholding

-   **Goal:** Proactively manage context *before* hitting the absolute limit.
-   **Implementation:**
    -   Continue using `tiktoken` for accurate counts.
    -   Define a threshold (e.g., 80-90% of the model's context limit).
    -   When the threshold is reached, trigger one of the above strategies (Summarization, Advanced Truncation) instead of waiting for the hard limit.

## 5. Recommendations for Groq Desktop

1.  **Implement Thresholding:** Trigger context management *before* hitting the model's hard limit (e.g., at 80-90% capacity) using `tiktoken`.
2.  **Prioritize Summarization:** Implement Strategy 4.1 (Summarization). This offers the best balance between token reduction and context preservation.
    -   Start by summarizing the *oldest* block of messages when the threshold is hit.
    -   Consider adding specific summarization for completed `tool_calls`/`role: "tool"` pairs, replacing the raw messages with a concise summary of the tool's action and result. This directly addresses the "Tool Call Bloat".
3.  **Refine Truncation (If Summarization is Too Slow/Costly):** If real-time summarization proves problematic, implement Strategy 4.2 (Advanced Truncation), keeping the first message and the N most recent, potentially combined with *offline* or periodic summarization of chat history stored locally.
4.  **Configuration:** Allow users (perhaps in advanced settings) to choose the context management strategy (e.g., "Truncate Oldest", "Summarize Oldest", "Keep Start/End") or adjust the threshold percentage.
5.  **Frameworks (Future):** While frameworks like LangChain offer pre-built memory modules [[1]](https://verticalserve.medium.com/genai-managing-context-history-best-practices-a350e57cc25f), integrating them deeply into the existing Electron/Node.js structure might require significant refactoring. Focus on implementing the core logic (summarization, thresholding) within the current architecture first (`chatHandler.js`, `messageUtils.js`).

## 6. References

[1] VerticalServe Medium Blog Post: GenAI — Managing Context History Best Practices (<https://verticalserve.medium.com/genai-managing-context-history-best-practices-a350e57cc25f>)
[2] OpenAI Community Forum: Best Practices for Chat Conversation Storage and Context Optimization (<https://community.openai.com/t/best-practices-for-chat-conversation-storage-and-context-optimization-with-openai-api-3-5-turbo/712166>)
[3] OpenAI Community Forum: How to manage chat history effectively? (<https://community.openai.com/t/how-to-manage-chat-history-effectively/1116419>)

## 7. Phased Implementation Plan (Revised)

This revised plan incorporates refined requirements for a more robust and efficient context management system, focusing on caching and preserving the full chat history.

**Phase 1: Core Logic & Fixed Token Target**

*   **Goal:** Establish the foundation for optimized history generation using a fixed token target and preserving the original history.
*   **Tasks:**
    1.  **Create `buildOptimizedHistory` Function:** This function will *replace* the core logic of `ensureContextFits`.
        *   **Input:** Full message history array, target token limit (e.g., 50,000), actual model context limit, current `cachedSummary` object (if any).
        *   **Output:** A *new* array of messages optimized for the API call, or the original prepared history if it fits.
        *   **Logic:**
            *   Calculate the effective limit: `min(target_token_limit, actual_model_context_window)`.
            *   Calculate tokens for the full history (including system prompt).
            *   If full history fits within the effective limit, return it (prepared).
            *   If not, proceed to check/use/generate summary (logic detailed in Phase 2).
        *   **Crucially:** This function *does not modify* the original full message history array.
    2.  **Integrate `buildOptimizedHistory`:** Modify `chatHandler.js` to call `buildOptimizedHistory` instead of `ensureContextFits`, passing the necessary parameters (including the current cache state, see Phase 2) and using its output for the API call.
    3.  **Testing:** Verify that the function correctly calculates limits, passes through history when it fits, and correctly identifies when optimization is needed.

**Phase 2: Summarization & Caching**

*   **Goal:** Implement the summarization process using the specified model and integrate the caching mechanism.
*   **Tasks:**
    1.  **Create `summarizeMessages` Function:**
        *   Implement a non-streaming HTTPS call to OpenRouter (`api/v1/chat/completions`).
        *   Use model: `google/gemini-2.0-flash-exp:free`.
        *   Use a specific, well-crafted system prompt instructing the model to summarize concisely, focusing on relevance to subsequent conversation, and retaining key details.
        *   Input: Array of messages to summarize.
        *   Output: Summary text string or an error indicator.
    2.  **Implement Caching Logic in `buildOptimizedHistory`:**
        *   When optimization is needed (full history > effective limit):
            *   Check for a valid `cachedSummary` object (passed as input). A cache is valid if it covers the messages that would need to be removed.
            *   **If Valid Cache:** Construct API history: `[System Prompt, Summary Message (from cache.text), Recent Messages]`. Ensure total tokens fit within the effective limit.
            *   **If No/Invalid Cache:**
                *   Identify messages requiring summarization (older messages beyond the effective limit, potentially including the text of the *old* summary if the cache was invalid).
                *   Call `summarizeMessages` with these messages.
                *   On success:
                    *   Create/Update the `cachedSummary` object (e.g., `{ text: "...", coversMessagesUpToIndex: N }`). Store this object (this will need to be passed back up and persisted).
                    *   Construct API history using the *new* summary.
                *   On failure: Fallback (e.g., simple truncation of oldest messages from the *optimized* list, log error).
    3.  **State Management & Persistence:**
        *   The `cachedSummary` object needs to be associated with the specific chat session.
        *   Modify chat loading/saving logic (`main.js`, potentially `ChatContext.jsx` via IPC) to persist and restore the `cachedSummary` object within the chat's JSON file.
        *   Ensure `chatHandler.js` receives the current `cachedSummary` for a chat and can signal back the updated cache object to be saved.
    4.  **Testing:** Verify summarization calls, cache creation, cache usage, cache invalidation/update, persistence, and fallback mechanisms. Test with long conversations requiring multiple summary updates.

**Phase 3: Tool Call Summarization (Integration)**

*   **Goal:** Enhance the summarization process to specifically handle tool calls if needed (potentially less critical with general summarization, but can be added).
*   **Tasks:**
    1.  **Refine `summarizeMessages` Prompt:** Explicitly instruct the summarization model to concisely represent tool interactions (e.g., "User asked to X, tool Y was run with args Z, result was W").
    2.  **(Optional) Targeted Tool Summarization:** If general summarization isn't sufficient, modify `buildOptimizedHistory` to identify and potentially summarize *individual* old tool sequences separately before summarizing the remaining old text messages. This adds complexity.
    3.  **Testing:** Ensure tool calls within the summarized portion are represented adequately in the summary text.

**Phase 4: User Configuration & Refinement**

*   **Goal:** Allow user control and refine the implementation.
*   **Tasks:**
    1.  **Add Settings:** Expose options in the UI/settings for:
        *   Target Token Limit (default 50,000).
        *   Enable/Disable Summarization (fallback to simple truncation if disabled).
        *   (Potentially) Clear Summary Cache for a chat.
    2.  **Integrate Settings:** Read and apply these settings in `chatHandler.js` / `buildOptimizedHistory`.
    3.  **Documentation:** Update user guides explaining the caching mechanism and settings.
    4.  **Refinement:** Tune the summarization prompt, default target limit, and cache validation logic based on testing and feedback.
