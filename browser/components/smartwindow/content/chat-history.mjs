/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, css, render } from "chrome://global/content/vendor/lit.all.mjs";

const { ChatHistory } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

/**
 * Fetches recent chat conversations from the last week
 *
 * @param {object} opts - Options
 * @param {number} opts.days - Days to look back (default: 7)
 * @returns {Promise<Array>} Array of conversations sorted by date
 */
async function getRecentConversations(opts = {}) {
  const days = opts.days ?? 7;
  const chatHistory = new ChatHistory();
  const endDate = Date.now();
  const startDate = endDate - days * 24 * 60 * 60 * 1000;

  try {
    const conversations = await chatHistory.findConversationsByDate(
      startDate,
      endDate
    );

    // Filter out conversations without messages
    const validConversations = conversations.filter(
      conv => conv.messages && !!conv.messages.length
    );

    // Sort by updated date (most recent first)
    validConversations.sort((a, b) => b.updatedDate - a.updatedDate);

    return validConversations;
  } catch (error) {
    console.error("Failed to fetch conversation history:", error);
    return [];
  }
}

/**
 * Groups conversations by date categories
 *
 * @param {Array} conversations - Array of conversations
 * @returns {object} Object with date groups
 */
function groupConversationsByDate(conversations) {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const groups = {
    today: [],
    yesterday: [],
    lastWeek: [],
    older: [],
  };

  for (const conv of conversations) {
    const age = now - conv.updatedDate;

    if (age < oneDayMs) {
      groups.today.push(conv);
    } else if (age < 2 * oneDayMs) {
      groups.yesterday.push(conv);
    } else if (age < 7 * oneDayMs) {
      groups.lastWeek.push(conv);
    } else {
      groups.older.push(conv);
    }
  }

  return groups;
}

/**
 * Extracts domain from URL
 *
 * @param {URL|string} url
 * @returns {string}
 */
function getDomain(url) {
  try {
    const urlObj = typeof url === "string" ? new URL(url) : url;
    return urlObj.hostname;
  } catch {
    return "";
  }
}

/**
 * Gets a preview of conversation (title or first message)
 *
 * @param {object} conversation
 * @returns {string}
 */
function getConversationPreview(conversation) {
  if (conversation.title && conversation.title.trim()) {
    return conversation.title;
  }

  // Fallback to first user message
  const firstUserMessage = conversation.messages?.find(
    m => m.role === ChatHistory.MESSAGE_ROLE.USER
  );

  if (firstUserMessage?.content) {
    const content = firstUserMessage.content.trim();
    return content.length > 60 ? content.substring(0, 60) + "..." : content;
  }

  return "Untitled conversation";
}

/**
 * Formats timestamp to relative time
 *
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }

  // Format as time for today/yesterday
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const daysDiff = Math.floor(diff / 86400000);
  if (daysDiff === 0) {
    return timeStr;
  }
  if (daysDiff === 1) {
    return `Yesterday ${timeStr}`;
  }
  if (daysDiff < 7) {
    return `${daysDiff}d ago`;
  }

  return date.toLocaleDateString();
}

/**
 * Filters conversations based on search query
 *
 * @param {Array} conversations
 * @param {string} query
 * @returns {Array}
 */
function filterConversations(conversations, query) {
  if (!query || !query.trim()) {
    return conversations;
  }

  const lowerQuery = query.toLowerCase();

  return conversations.filter(conv => {
    // Search in title
    if (conv.title?.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in URL
    if (conv.pageUrl?.href?.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in messages
    return conv.messages?.some(msg =>
      msg.content?.toLowerCase().includes(lowerQuery)
    );
  });
}

/**
 * Creates a conversation list item
 *
 * @param {object} conversation
 * @param {Function} onClick
 * @returns {TemplateResult}
 */
function createConversationItem(conversation, onClick) {
  const preview = getConversationPreview(conversation);
  const domain = conversation.pageUrl ? getDomain(conversation.pageUrl) : "";
  const messageCount = conversation.messages?.length || 0;
  const timestamp = formatTimestamp(conversation.updatedDate);

  return html`
    <div class="conversation-item" @click=${() => onClick(conversation)}>
      <div class="conversation-header">
        <div class="conversation-title">${preview}</div>
        <div class="conversation-time">${timestamp}</div>
      </div>
      ${domain ? html`<div class="conversation-url">${domain}</div>` : ""}
      <div class="conversation-meta">
        <span class="message-count">${messageCount} messages</span>
      </div>
    </div>
  `;
}

/**
 * Creates the history overlay component
 *
 * @param {Function} onClose - Callback when modal closes
 * @param {Function} onSelectConversation - Callback when conversation is selected
 * @returns {TemplateResult}
 */
export function createHistoryOverlay(onClose, onSelectConversation) {
  let conversations = [];
  let filteredConversations = [];
  let searchQuery = "";
  let isLoading = true;
  let error = null;

  // Fetch conversations
  getRecentConversations({ days: 7 })
    .then(result => {
      conversations = result;
      filteredConversations = result;
      isLoading = false;
      renderOverlay();
    })
    .catch(err => {
      error = err.message || "Failed to load conversations";
      isLoading = false;
      renderOverlay();
    });

  const handleSearch = event => {
    searchQuery = event.target.value;
    filteredConversations = filterConversations(conversations, searchQuery);
    renderOverlay();
  };

  const handleSelectConversation = conversation => {
    onSelectConversation(conversation);
    onClose();
  };

  const renderContent = () => {
    if (isLoading) {
      return html`
        <div class="loading-indicator">
          <div class="spinner"></div>
          <span>Loading conversations...</span>
        </div>
      `;
    }

    if (error) {
      return html`<div class="error-message">Error: ${error}</div>`;
    }

    if (filteredConversations.length === 0) {
      return html`
        <div class="empty-state">
          ${searchQuery
            ? html`<p>No conversations match your search.</p>`
            : html`<p>No recent conversations found.</p>
                <p class="empty-hint">
                  Start chatting to see your conversation history here.
                </p>`}
        </div>
      `;
    }

    const groups = groupConversationsByDate(filteredConversations);

    return html`
      <div class="conversations-list">
        ${groups.today.length
          ? html`
              <div class="date-group">
                <h4 class="date-group-title">Today</h4>
                ${groups.today.map(conv =>
                  createConversationItem(conv, handleSelectConversation)
                )}
              </div>
            `
          : ""}
        ${groups.yesterday.length
          ? html`
              <div class="date-group">
                <h4 class="date-group-title">Yesterday</h4>
                ${groups.yesterday.map(conv =>
                  createConversationItem(conv, handleSelectConversation)
                )}
              </div>
            `
          : ""}
        ${groups.lastWeek.length
          ? html`
              <div class="date-group">
                <h4 class="date-group-title">Last Week</h4>
                ${groups.lastWeek.map(conv =>
                  createConversationItem(conv, handleSelectConversation)
                )}
              </div>
            `
          : ""}
        ${groups.older.length
          ? html`
              <div class="date-group">
                <h4 class="date-group-title">Older</h4>
                ${groups.older.map(conv =>
                  createConversationItem(conv, handleSelectConversation)
                )}
              </div>
            `
          : ""}
      </div>
    `;
  };

  const renderOverlay = () => {
    const overlayTemplate = html`
      <style>
        ${historyStyles.cssText}
      </style>
      <div class="history-overlay" @click=${onClose}>
        <div class="history-modal" @click=${e => e.stopPropagation()}>
          <div class="history-header">
            <h3>Chat History</h3>
            <button class="close-btn" @click=${onClose}>×</button>
          </div>

          <div class="search-container">
            <input
              type="text"
              class="search-input"
              placeholder="Search conversations..."
              @input=${handleSearch}
              .value=${searchQuery}
            />
          </div>

          <div class="history-content">${renderContent()}</div>
        </div>
      </div>
    `;

    const container = document.getElementById("history-overlay-root");
    if (container) {
      render(overlayTemplate, container);
    }
  };

  // Initial render
  renderOverlay();

  return renderOverlay;
}

/**
 * Shows the history overlay
 *
 * @param {Function} onSelectConversation - Callback when conversation is selected
 */
export function showChatHistoryOverlay(onSelectConversation) {
  // Create overlay root if it doesn't exist
  let container = document.getElementById("history-overlay-root");
  if (!container) {
    container = document.createElement("div");
    container.id = "history-overlay-root";
    document.body.appendChild(container);
  }

  const onClose = () => {
    render(null, container);
  };

  createHistoryOverlay(onClose, onSelectConversation);
}

// Styles for the history overlay
const historyStyles = css`
  .history-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .history-modal {
    background: white;
    border-radius: 8px;
    max-width: 700px;
    max-height: 80vh;
    width: 90%;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
  }

  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
  }

  .history-header h3 {
    margin: 0;
    color: #333;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    margin: 0;
  }

  .close-btn:hover {
    background: #e0e0e0;
  }

  .search-container {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: white;
  }

  .search-input {
    width: 100%;
    padding: 0.75rem 1rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    font-size: 0.875rem;
    box-sizing: border-box;
  }

  .search-input:focus {
    outline: none;
    border-color: #0066cc;
    box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
  }

  .history-content {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.5rem;
    min-height: 300px;
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 3rem 1rem;
    color: #666;
    font-size: 0.875rem;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #e0e0e0;
    border-top-color: #0066cc;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-message {
    padding: 1rem;
    background: #fee;
    border-left: 4px solid #c00;
    color: #800;
    font-size: 0.875rem;
    border-radius: 4px;
    margin: 1rem 0;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #666;
  }

  .empty-state p {
    margin: 0.5rem 0;
  }

  .empty-hint {
    font-size: 0.875rem;
    color: #999;
  }

  .conversations-list {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .date-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .date-group-title {
    margin: 0 0 0.5rem 0;
    color: #666;
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .conversation-item {
    padding: 1rem;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    background: white;
  }

  .conversation-item:hover {
    border-color: #0066cc;
    background: #f8f9fa;
    box-shadow: 0 2px 8px rgba(0, 102, 204, 0.1);
  }

  .conversation-header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .conversation-title {
    flex: 1;
    font-weight: 600;
    color: #333;
    font-size: 0.9375rem;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .conversation-time {
    font-size: 0.75rem;
    color: #999;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .conversation-url {
    font-size: 0.75rem;
    color: #0066cc;
    margin-bottom: 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conversation-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #666;
  }

  .message-count {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
`;
