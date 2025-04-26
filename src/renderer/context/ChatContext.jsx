import React, { createContext, useState, useContext } from 'react';

// Create the context
const ChatContext = createContext();

// Create a provider component
export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null); // ID of the currently loaded chat
  const [savedChats, setSavedChats] = useState([]); // List of { id, title, lastModified } for the sidebar

  // Placeholder functions (will be expanded later or used directly)
  const loadChat = (chatId) => {
    // TODO: Implement logic to load chat data via IPC and set messages/activeChatId
    console.log("Placeholder: Load chat", chatId);
  };

  const createNewChat = () => {
    // TODO: Implement logic to clear messages and set activeChatId to null
    console.log("Placeholder: Create new chat");
  };

  const deleteChat = (chatId) => {
    // TODO: Implement logic to call IPC delete and refresh savedChats
    console.log("Placeholder: Delete chat", chatId);
  };

  // Provide the state and setters to children
  const value = {
    messages,
    setMessages,
    activeChatId,
    setActiveChatId, // Expose setter directly for now
    savedChats,
    setSavedChats,   // Expose setter directly for now
    // Add placeholder action functions (optional, could be handled in App.jsx)
    loadChat, 
    createNewChat, 
    deleteChat
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

// Create a custom hook for easy context consumption
export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}; 