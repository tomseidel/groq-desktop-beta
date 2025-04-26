import React, { useState } from 'react';
import { useChat } from '../context/ChatContext'; // Adjust path if needed

function ChatListSidebar({ onNewChat, onSelectChat, onDeleteChat, onRenameChat }) {
  const { savedChats, activeChatId } = useChat();
  const [editingChatId, setEditingChatId] = useState(null);
  const [editText, setEditText] = useState('');

  const handleStartEdit = (chat) => {
    setEditingChatId(chat.id);
    setEditText(chat.title);
  };

  const handleCancelEdit = () => {
    setEditingChatId(null);
    setEditText('');
  };

  const handleSaveEdit = () => {
    if (editingChatId && editText.trim()) {
      onRenameChat(editingChatId, editText.trim());
    }
    // Reset editing state regardless of success (App.jsx handles list refresh)
    handleCancelEdit(); 
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      handleSaveEdit();
    } else if (event.key === 'Escape') {
      handleCancelEdit();
    }
  };

  // TODO: Implement rendering logic for the sidebar:
  // - "New Chat" button (calls createNewChat)
  // - List of savedChats:
  //   - Each item clickable (calls loadChat(chat.id))
  //   - Highlight the item where chat.id === activeChatId
  //   - Add a delete button/icon per item (calls deleteChat(chat.id))

  return (
    <div className="chat-list-sidebar bg-gray-800 text-white w-64 h-full flex flex-col p-2">
      {/* --- Header --- */}
      <div className="mb-4">
        <button
          onClick={onNewChat}
          className="w-full bg-primary hover:bg-primary-dark text-white font-bold py-2 px-4 rounded transition duration-150 ease-in-out"
        >
          New Chat
        </button>
      </div>

      {/* --- Chat List --- */}
      <div className="flex-1 overflow-y-auto">
        {savedChats.length === 0 && (
          <p className="text-gray-400 text-sm text-center">No saved chats yet.</p>
        )}
        {/* Placeholder for chat list items */}
        <ul>
          {savedChats.map((chat) => (
            <li
              key={chat.id}
              className={`p-2 rounded hover:bg-gray-700 cursor-pointer mb-1 flex justify-between items-center ${
                chat.id === activeChatId ? 'bg-gray-600 font-semibold' : ''
              }`}
              onClick={() => {if (!editingChatId) onSelectChat(chat.id)}}
            >
              {editingChatId === chat.id ? (
                <input 
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleCancelEdit}
                  className="flex-1 bg-gray-600 text-white p-1 rounded mr-2 focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate flex-1 mr-2" title={chat.title}>{chat.title}</span>
              )}
              {editingChatId === chat.id ? (
                <>
                  <button
                    onClick={(e) => {e.stopPropagation(); handleSaveEdit();}}
                    className="text-green-500 hover:text-green-400 text-xs p-1 mr-1"
                    title="Save Title"
                  >
                    ✓
                  </button>
                  <button
                    onClick={(e) => {e.stopPropagation(); handleCancelEdit();}}
                    className="text-red-500 hover:text-red-400 text-xs p-1"
                    title="Cancel Edit"
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); 
                      handleStartEdit(chat);
                    }}
                    className="text-gray-400 hover:text-blue-500 text-xs p-1 mr-1"
                    title="Rename Chat"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); 
                      onDeleteChat(chat.id);
                    }}
                    className="text-gray-400 hover:text-red-500 text-xs p-1"
                    title="Delete Chat"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                       <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* --- Footer (Optional) --- */}
      {/* <div className="mt-auto"> Footer content </div> */}
    </div>
  );
}

export default ChatListSidebar; 