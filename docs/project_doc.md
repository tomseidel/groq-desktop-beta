# Groq Desktop Project Documentation

## 1. Project Overview

Groq Desktop is an Electron-based desktop application that provides a chat interface for interacting with various Large Language Models (LLMs). It supports configurable API endpoints (initially Groq and OpenRouter), dynamic model fetching, Model Context Protocol (MCP) for function calling capabilities, and persistent chat storage.

The application is built using web technologies (React, Vite, TailwindCSS) for the user interface (renderer process) and Node.js for the backend logic (main process) running within Electron.

## 2. Technology Stack

-   **Framework:** Electron
-   **Frontend:** React (with Vite), TailwindCSS
-   **Backend:** Node.js
-   **Language:** JavaScript (JSX)
-   **API Integration:** Standard Node.js `https` / `electron.net` modules using OpenAI-compatible API format. Model Context Protocol SDK (`@modelcontextprotocol/sdk`) for tools.
-   **Package Manager:** pnpm
-   **Bundler/Build Tool:** Vite, Electron Builder

## 3. Directory Structure

```
.
├── docs/                 # Project documentation (like this file)
├── electron/             # Electron main process code
│   ├── main.js           # Main process entry point, window/IPC handling, model fetching
│   ├── preload.js        # Electron preload script for secure IPC
│   ├── chatHandler.js    # Logic for handling chat streaming API calls (OpenAI format)
│   ├── messageUtils.js   # Utilities for chat history pruning based on model context
│   ├── mcpManager.js     # Logic for managing MCP server instances
│   ├── toolHandler.js    # Logic for handling function calls/tools via MCP
│   ├── settingsManager.js # Logic for managing application settings (API keys, platform, etc.)
│   ├── windowManager.js  # Logic for managing application windows
│   └── ...               # Other main process utilities and scripts
├── node_modules/         # Project dependencies
├── public/               # Static assets (icons, build resources)
├── release/              # Output directory for packaged application builds
├── shared/               # Code potentially shared between main and renderer (if any)
├── src/                  # Frontend (Renderer process) source code
│   ├── main/             # Potentially code shared specifically for main process build (needs verification)
│   └── renderer/         # React application code
│       ├── components/   # Reusable React UI components
│       ├── context/      # React context providers (state management, e.g., ChatContext)
│       ├── pages/        # Top-level page components (e.g., Chat, Settings)
│       ├── App.jsx       # Main React application component (routing, layout, core logic)
│       ├── main.jsx      # Renderer process entry point (React DOM rendering)
│       └── index.css     # Global CSS and Tailwind base styles
├── .github/              # GitHub Actions workflows (if any)
├── .gitignore            # Git ignore rules
├── eslint.config.js      # ESLint configuration
├── index.html            # HTML template for Vite/React app
├── package.json          # Project metadata, dependencies, and scripts
├── pnpm-lock.yaml        # pnpm lockfile
├── postcss.config.cjs    # PostCSS configuration
├── README.md             # Project README
├── tailwind.config.cjs   # TailwindCSS configuration
└── vite.config.cjs       # Vite configuration
```

## 4. Core Components & Features

-   **Chat Interface:** (`src/renderer/`, `electron/chatHandler.js`, `electron/messageUtils.js`, `electron/fileExtractor.js`, `src/renderer/components/Message.jsx`)
    -   Provides a UI for sending messages to LLMs, supporting text and file attachments.
    -   **File Attachments:**
        -   UI (`src/renderer/components/ChatInput.jsx`) allows attaching files via button click, drag-and-drop, or pasting.
        -   Shows previews: thumbnails for images, status icons (pending, extracting, complete, error) for other files.
        -   Enforces a 1-image limit when using Groq vision models.
        -   Background text extraction for supported file types (`.txt`, `.md`, `.pdf`, `.docx`) handled via IPC (`electron/main.js`, `electron/fileExtractor.js`) using libraries like `pdf-parse` and `mammoth`.
        -   Displays attached file placeholders (icons, filenames) in the chat history (`src/renderer/components/MessageList.jsx`).
    -   Supports platform selection (Groq, OpenRouter) and dynamic model loading/selection per platform, including pricing display for OpenRouter models.
    -   Supports rendering Markdown and code blocks in responses.
    -   **Backend Chat Logic (`electron/chatHandler.js`):** Uses standard HTTPS requests with OpenAI-compatible API format.
        -   Handles streaming responses, including detecting tool call requests (`finish_reason: 'tool_calls'`).
        -   Manages the two-step API call process required for tool execution:
            1.  Sends initial prompt and tool definitions.
            2.  If tool calls are requested, executes them via `toolHandler.js`.
            3.  Sends tool results back to the API to get the final response.
        -   Includes extracted file content in the prompt sent to the LLM.
        -   Strips image data from older messages to preserve context window.
        -   Handles Groq vision model limitations (1 image, no system prompt with images).
    -   **Tool Use Visualization (`src/renderer/App.jsx`, `src/renderer/components/Message.jsx`):**
        -   Receives IPC events (`tool-call-start`, `tool-call-end`) from the backend during tool execution.
        -   Uses `thinkingSteps` state (`ChatContext.jsx`) to track live tool call progress.
        -   Displays an inline, collapsible "Thinking Steps" section within assistant messages during tool execution, showing:
            -   Tool name.
            -   Collapsible arguments.
            -   Status indicator (spinner, checkmark, error icon).
            -   Collapsible result or error message upon completion.
        -   Renders historical tool calls (from saved `tool_calls` and `role: "tool"` messages) in a similar read-only format when loading chats.
    -   Accurate context window management (`electron/chatHandler.js`, using `tiktoken`): Automatically truncates older messages to fit within the selected model's context limit, including accounting for tool call/result messages.
-   **Platform/Model Management:** (`electron/main.js`, `src/renderer/App.jsx`)
    -   Fetches available models dynamically from configured platforms (Groq, OpenRouter) via their APIs, including vision support flags and OpenRouter pricing.
    -   Allows users to switch platforms and select models through the UI.
    -   Saves and loads the selected platform/model with each chat session.
-   **Chat Persistence:** (`electron/main.js`, `src/renderer/App.jsx`, `src/renderer/context/ChatContext.jsx`)
    -   Saves chat history (messages, title, platform, model) to local JSON files, transforming file content messages for consistent display.
    -   **Saves full tool use context:** Includes assistant messages requesting tool calls (`tool_calls` array) and the corresponding tool result messages (`role: "tool"`) in the saved JSON.
    -   Loads previous chats from the sidebar.
    -   Handles creation of new chats and deletion/renaming of existing chats.
-   **MCP Server Support:** (`electron/mcpManager.js`, `electron/toolHandler.js`)
    -   Manages local MCP server instances to enable function calling with capable models.
    -   Handles tool registration, execution requests, and responses.
    -   Integrates with `chatHandler.js` to execute tool calls requested by the LLM during streaming.
-   **Settings Management:** (`src/renderer/pages/Settings.jsx` (likely), `electron/settingsManager.js`)
    -   Allows users to input and save API keys (Groq, OpenRouter), select default platform/model, configure MCP servers, etc.
    -   Backend logic for storing/retrieving settings in `electron/settingsManager.js`.
-   **Electron Shell:** (`electron/main.js`, `electron/windowManager.js`)
    -   Manages the application lifecycle, window creation, and communication between the main and renderer processes (IPC).

## 5. Build & Run Instructions

**Prerequisites:**

-   Node.js (v18+)
-   pnpm

**Setup:**

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    pnpm install
    ```

**Development:**

Start the development server (Vite + Electron):

```bash
pnpm dev
```

**Production Build:**

Build and package the application for distribution:

```bash
pnpm dist
```

Installable packages will be created in the `release/` directory.

To run the app in dev mode, you can use the following command:

```bash
pnpm dev
```


