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

-   **Chat Interface:** (`src/renderer/`, `electron/chatHandler.js`, `electron/messageUtils.js`)
    -   Provides a UI for sending messages (including potential future image/file support) to LLMs.
    -   Supports platform selection (Groq, OpenRouter) and dynamic model loading/selection per platform.
    -   Supports rendering Markdown and code blocks.
    -   Frontend components in `src/renderer/components/` and `src/renderer/pages/`, state managed likely in `src/renderer/context/`.
    -   Backend chat logic (`electron/chatHandler.js`) uses standard HTTPS requests with OpenAI-compatible API format.
    -   Dynamic chat history pruning (`electron/messageUtils.js`) based on the selected model's context window size.
-   **Platform/Model Management:** (`electron/main.js`, `src/renderer/App.jsx`)
    -   Fetches available models dynamically from configured platforms (Groq, OpenRouter) via their APIs.
    -   Allows users to switch platforms and select models through the UI.
    -   Saves and loads the selected platform/model with each chat session.
-   **Chat Persistence:** (`electron/main.js`, `src/renderer/App.jsx`, `src/renderer/context/ChatContext.jsx`)
    -   Saves chat history (messages, title, platform, model) to local JSON files.
    -   Loads previous chats from the sidebar.
    -   Handles creation of new chats and deletion/renaming of existing chats.
-   **MCP Server Support:** (`electron/mcpManager.js`, `electron/toolHandler.js`)
    -   Manages local MCP server instances to enable function calling with capable models.
    -   Handles tool registration, execution requests, and responses.
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
