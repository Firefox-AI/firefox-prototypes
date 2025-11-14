/*
 This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};

/**
 * Simple interface to store and retrieve chat conversations and messages.
 *
 * See: https://docs.google.com/document/d/1VlwmGbMhPIe-tmeKWinHuPh50VC9QrWEeQQ5V-UvEso/edit?tab=t.klqqibndv3zk
 *
 * @example
 * let { ChatHistory, ChatHistoryConversation, ChatHistoryMessage } =
 *   ChromeUtils.importESModule("resource:///modules/smartwindow/ChatHistory.sys.mjs");
 * const chatHistory = new ChatHistory();
 * const conversation = new ChatHistoryConversation({
 *   title: "title",
 *   description: "description",
 *   pageUrl: new URL("https://mozilla.com/"),
 *   pageMeta: { one: 1, two: 2 },
 * });
 * const msg1 = new ChatHistoryMessage({
 *   ordinal: 0,
 *   role: ChatHistory.MESSAGE_ROLE.USER,
 *   modelId: "test",
 *   params: { one: "one" },
 *   usage: { two: "two", content: "some content" },
 * });
 * const msg2 = new ChatHistoryMessage({
 *   ordinal: 1,
 *   role: ChatHistory.MESSAGE_ROLE.ASSISTANT,
 *   modelId: "test",
 *   params: { one: "one" },
 *   usage: { two: "two", content: "some content 2" },
 * });
 * conversation.messages = [msg1, msg2];
 * await chatHistory.updateConversation(conversation);
 * // Or findConversationsByDate, findConversationsByURL.
 * const foundConversation =
 *   await chatHistory.findConversationById(conversation.id);
 */

ChromeUtils.defineESModuleGetters(lazy, {
  CryptoUtils: "moz-src:///services/crypto/modules/utils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "ChatHistory",
    maxLogLevelPref: "browser.smartwindow.chatHistory.loglevel",
  });
});

// Every time the schema or the underlying data changes, you must bump up the
// schema version.

// Remember to:
// 1. Bump up the version number
// 2. Add a migration function to migrate the data to the new schema.
// 3. Update #createDatabaseEntities and #checkDatabaseHealth
// 4. Add a test to check that the migration works correctly.

// Note: migrations should be re-entering-friendly to a certain degree; if the
// user downgrades the schema version is bumped down, and on a further upgrade
// the migration step is applied again. This ensures that if certain entries
// must be converted they will be, even if they were added after a downgrade.
// In practice changes to the schema should be additive, and a newer version
// should continue working on a previous one, altough with reduced capabilities.

// Note: migrations should be reasonably re-entry-friendly. If the user
// downgrades, the schema version is decreased, and upon a subsequent upgrade,
// the migration step is reapplied.
// This ensures that any necessary conversions are performed, even for entries
// added after the downgrade.
// In practice, schema changes should be additive, allowing newer versions to
// operate on older schemas, albeit with potentially reduced functionality.

const CURRENT_SCHEMA_VERSION = 4;

const DB_FOLDER_PATH = PathUtils.profileDir;
const DB_FILE_NAME = "chat-history.sqlite";

const PREF_BRANCH = "browser.smartWindow.chatHistory";

/**
 * @typedef MessageRole
 * @property {number} USER - Role for user messages
 * @property {number} ASSISTANT - Role for assistant messages
 * @property {number} SYSTEM - Role for system messages
 * @property {number} TOOL - Role for tool messages
 */
const MESSAGE_ROLE = Object.freeze({
  USER: 0,
  ASSISTANT: 1,
  SYSTEM: 2,
  TOOL: 3,
});

/**
 * @typedef ConversationStatus
 * @property {number} ACTIVE - An active conversation
 * @property {number} ARCHIVE - An archived conversation
 * @property {number} DELETED - A deleted conversation
 */
const CONVERSATION_STATUS = Object.freeze({
  ACTIVE: 0,
  ARCHIVED: 1,
  DELETED: 2,
});

/**
 * Class to manage the chat history database.
 *
 * @typedef {object} ChatHistory
 * @property {Promise} promiseConn - Promise for the db connection
 */
export class ChatHistory {
  #asyncShutdownBlocker;
  #conn;
  #promiseConn;

  constructor() {
    let asyncShutdownBlocker = async () => {
      await this.closeConnection();
    };
    this.#asyncShutdownBlocker = asyncShutdownBlocker.bind(this);
  }

  static get CONVERSATION_STATUS() {
    return CONVERSATION_STATUS;
  }

  static get MESSAGE_ROLE() {
    return MESSAGE_ROLE;
  }

  get CURRENT_SCHEMA_VERSION() {
    return CURRENT_SCHEMA_VERSION;
  }

  get connection() {
    return this.#conn;
  }
  get databaseFileName() {
    return DB_FILE_NAME;
  }

  get databaseFilePath() {
    return PathUtils.join(PathUtils.profileDir, this.databaseFileName);
  }

  get #removeDatabaseOnStartup() {
    return Services.prefs.getBoolPref(
      `${PREF_BRANCH}.removeDatabaseOnStartup`,
      false
    );
  }
  set #removeDatabaseOnStartup(value) {
    lazy.logConsole.debug(`Setting removeDatabaseOnStartup to ${value}`);
    Services.prefs.setBoolPref(`${PREF_BRANCH}.removeDatabaseOnStartup`, value);
  }

  async ensureDatabase() {
    if (this.#promiseConn) {
      return this.#promiseConn;
    }

    let deferred = Promise.withResolvers();
    this.#promiseConn = deferred.promise;
    if (this.#removeDatabaseOnStartup) {
      lazy.logConsole.debug("Removing database on startup");
      try {
        await this.removeDatabaseFiles();
      } catch (e) {
        deferred.reject(new Error("Could not remove the database files"));
        return deferred.promise;
      }
    }

    try {
      await this.#openConnection();
    } catch (e) {
      if (
        e.result == Cr.NS_ERROR_FILE_CORRUPTED ||
        e.errors?.some(error => error.result == Ci.mozIStorageError.NOTADB)
      ) {
        lazy.logConsole.debug("Invalid database detected, removing it.", e);
        await this.removeDatabaseFiles();
      }
    }

    if (!this.#conn) {
      try {
        await this.#openConnection();
      } catch (e) {
        lazy.logConsole.error("Could not open the database connection.", e);
        deferred.reject(new Error("Could not open the database connection"));
        return deferred.promise;
      }
    }

    try {
      await this.#initializeSchema();
    } catch (e) {
      lazy.logConsole.warn(
        "Failed to initialize the database schema, recreating the database.",
        e
      );
      // If the schema cannot be initialized try to create a new database file.
      await this.removeDatabaseFiles();
    }
    if (!this.#conn) {
      try {
        await this.#openConnection();
        await this.#initializeSchema();
      } catch (e) {
        lazy.logConsole.error("Could not open the database connection.", e);
        deferred.reject(new Error("Could not open the database connection"));
        return deferred.promise;
      }
    }

    deferred.resolve(this.#conn);
    return this.#promiseConn;
  }

  async #openConnection() {
    lazy.logConsole.debug("Opening new connection");
    this.#conn = await lazy.Sqlite.openConnection({
      path: this.databaseFilePath,
    });
    lazy.Sqlite.shutdown.addBlocker(
      "ChatHistory: Shutdown",
      this.#asyncShutdownBlocker
    );

    // Setup WAL journaling, as it is generally faster.
    await this.#conn.execute("PRAGMA journal_mode = WAL");
    await this.#conn.execute("PRAGMA wal_autocheckpoint = 16");

    // Store VACUUM information to be used by the VacuumManager.
    await this.#conn.execute("PRAGMA auto_vacuum = INCREMENTAL");
    await this.#conn.execute("PRAGMA foreign_keys = ON");
  }

  async closeConnection() {
    if (this.#conn) {
      lazy.logConsole.debug("Closing connection");
      lazy.Sqlite.shutdown.removeBlocker(this.#asyncShutdownBlocker);
      await this.#conn.close();
      this.#conn = null;
    }
  }

  async #initializeSchema() {
    lazy.logConsole.debug("Initializing the database schema");
    let version = await this.#conn.getSchemaVersion();
    if (version == CURRENT_SCHEMA_VERSION) {
      return;
    }

    if (version > CURRENT_SCHEMA_VERSION) {
      lazy.logConsole.debug("Downgrading the database schema version");
      await this.#conn.setSchemaVersion(CURRENT_SCHEMA_VERSION);
      return;
    }

    // Must migrate the schema.
    await this.#conn.executeTransaction(async () => {
      if (version == 0) {
        // This is a newly created database, just create the entities.
        await this.#createDatabaseEntities();
        await this.#conn.setSchemaVersion(CURRENT_SCHEMA_VERSION);
        // eslint-disable-next-line no-useless-return
        return;
      }

      // Put migrations here with a brief description of what they do.
      await this.applyV4(version);

      /* Example:
      if (version < 2) {
        // Add a new column for...
      }
      */

      await this.#conn.setSchemaVersion(CURRENT_SCHEMA_VERSION);
    });
  }

  /**
   * This migration should have been V3, but had to be updated to V4 to fix
   * an error with the initial V3 migration code.
   *
   * - Adds page_url to message in order to track the page URL that the
   *   user was on when message was submitted, allows opening up conversation
   *   on the last url of the conversation, as well as searching for conversations
   *   that happened over a particular url.
   *
   * - Adds turn_index to track logical steps, it groups all messages type
   *   on a per turn basis.
   *
   *  @param {number} version - The version number of the current schema
   */
  async applyV4(version) {
    if (version < 4) {
      // Drop the summary table, it is no longer needed
      await this.#conn.execute(`DROP TABLE IF EXISTS summary;`);

      try {
        await this.#conn.execute("SELECT page_url FROM message LIMIT 1;");
      } catch (e) {
        // Add a page_url column to the message table to keep track
        // of the pages visitedjduring a conversation and when they
        // were visited
        await this.#conn.execute(`
          ALTER TABLE message ADD COLUMN page_url TEXT;
        `);
      }

      try {
        await this.#conn.execute("SELECT turn_index FROM message LIMIT 1;");
      } catch (e) {
        // Add a turn_index column to group all types of messages into a
        // particular turn, ex: prompt -> response would be a single turn.
        await this.#conn.execute(`
          ALTER TABLE message ADD COLUMN turn_index INTEGER;
        `);
      }
    }
  }

  async #createDatabaseEntities() {
    await this.#conn.execute(`
      CREATE TABLE conversation (
        conv_id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        page_url TEXT,
        page_meta_jsonb BLOB,
        created_date INTEGER NOT NULL,
        updated_date INTEGER NOT NULL,
        status INTEGER NOT NULL DEFAULT 0,
        active_branch_tip_message_id TEXT -- no foreign here, as we insert messages later.
      ) WITHOUT ROWID;
    `);
    await this.#conn.execute(`
      CREATE INDEX conversation_url_idx ON conversation(page_url, status, updated_date);
    `);
    await this.#conn.execute(`
      CREATE TABLE message (
        message_id TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL REFERENCES conversation(conv_id) ON DELETE CASCADE,
        created_date INTEGER NOT NULL,
        parent_message_id TEXT REFERENCES message(message_id) ON DELETE CASCADE,
        revision_root_message_id TEXT REFERENCES message(message_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        is_active_branch INTEGER NOT NULL,
        role INTEGER NOT NULL,
        model_id TEXT,
        params_jsonb BLOB,
        content TEXT,
        usage_jsonb BLOB,
        page_url TEXT,
        turn_index INTEGER
      ) WITHOUT ROWID;
    `);
    await this.#conn.execute(`
      CREATE INDEX message_ordinal_idx ON message(ordinal);
    `);
  }

  async removeDatabaseFiles() {
    lazy.logConsole.debug("Removing database files");
    await this.closeConnection();
    try {
      for (let file of [
        this.databaseFilePath,
        PathUtils.join(DB_FOLDER_PATH, this.databaseFileName + "-wal"),
        PathUtils.join(DB_FOLDER_PATH, this.databaseFileName + "-shm"),
      ]) {
        lazy.logConsole.debug(`Removing ${file}`);
        await IOUtils.remove(file, {
          retryReadonly: true,
          recursive: true,
          ignoreAbsent: true,
        });
      }
      this.#removeDatabaseOnStartup = false;
    } catch (e) {
      lazy.logConsole.warn("Failed to remove database files", e);
      // Try to clear on next startup.
      this.#removeDatabaseOnStartup = true;
      // Re-throw the exception for the caller.
      throw e;
    }
  }

  /**
   *
   * @param {ChatHistoryConversation} conversation
   */
  async updateConversation(conversation) {
    await this.ensureDatabase();

    let pageUrl;
    try {
      pageUrl = new URL(conversation.pageUrl);
    } catch (e) {
      pageUrl = null;
    }

    await this.#conn.executeTransaction(async () => {
      lazy.logConsole.debug(`inserting conversation ${conversation.id}`);
      await this.#conn.executeCached(
        `
        INSERT INTO conversation (
          conv_id, title, description, page_url, page_meta_jsonb,
          created_date, updated_date, status, active_branch_tip_message_id
        ) VALUES (
          :conv_id, :title, :description, :page_url, jsonb(:page_meta),
          :created_date, :updated_date, :status, :active_branch_tip_message_id
        )
        ON CONFLICT(conv_id) DO UPDATE
          SET title = :title,
              updated_date = :updated_date,
              status = :status,
              active_branch_tip_message_id = :active_branch_tip_message_id
          `,
        {
          conv_id: conversation.id,
          title: conversation.title,
          description: conversation.description,
          page_url: pageUrl?.href ?? null,
          page_meta: conversation.pageMeta
            ? JSON.stringify(conversation.pageMeta)
            : null,
          created_date: conversation.createdDate,
          updated_date: conversation.updatedDate,
          status: conversation.status,
          active_branch_tip_message_id: conversation.activeBranchTipMessageId,
        }
      );

      lazy.logConsole.debug(
        `inserting messages for conversation ${conversation.id}`
      );
      let messages = conversation.messages.map(m => ({
        message_id: m.id,
        conv_id: conversation.id,
        created_date: m.createdDate,
        parent_message_id: m.parentMessageId,
        revision_root_message_id: m.revisionRootMessageId,
        ordinal: m.ordinal,
        is_active_branch: m.isActiveBranch ? 1 : 0,
        role: m.role,
        model_id: m.modelId,
        params: m.params ? JSON.stringify(m.params) : null,
        content: m.content,
        usage: m.usage ? JSON.stringify(m.usage) : null,
        page_url: m.page_url?.href || "",
        turn_index: m.turn_index,
      }));
      await this.#conn.executeCached(
        `
        INSERT INTO message (
          message_id, conv_id, created_date, parent_message_id,
          revision_root_message_id, ordinal, is_active_branch, role,
          model_id, params_jsonb, content, usage_jsonb, page_url, turn_index
        ) VALUES (
          :message_id, :conv_id, :created_date, :parent_message_id,
          :revision_root_message_id, :ordinal, :is_active_branch, :role,
          :model_id, jsonb(:params), :content, jsonb(:usage), :page_url, :turn_index
        )
        ON CONFLICT(message_id) DO UPDATE SET
          is_active_branch = :is_active_branch
        `,
        messages
      );
    });
  }

  /**
   * Gets a list of most recent conversations
   *
   * @param {number} numberOfConversations - How many convos to retrieve
   * @returns {Array<RecentChatEntry>} - List of RecentChatEntry items
   */
  async findRecentConversations(numberOfConversations) {
    try {
      await this.ensureDatabase();

      let rows = await this.#conn.executeCached(
        `
        SELECT conv_id, title
        FROM conversation
        ORDER BY updated_date DESC
        LIMIT :limit
      `,
        { limit: numberOfConversations }
      );

      return rows.map(row => {
        return new RecentChatEntry({
          conv_id: row.getResultByName("conv_id"),
          title: row.getResultByName("title"),
        });
      });
    } catch (error) {
      console.error("Error:", error);

      return [];
    }
  }

  async findConversationById(conversationId) {
    await this.ensureDatabase();

    // TODO: Check summary first, find the one with the largest end_ordinal.
    // If not found retrieve all messages.
    // If found compare end_ordinal of the summary with active branch ordinal
    // to determine if extra messages must be retrieved.
    let rows = await this.#conn.executeCached(
      `
        SELECT conv_id, title, description, page_url,
          json(page_meta_jsonb) AS page_meta, created_date, updated_date,
          status, active_branch_tip_message_id
        FROM conversation WHERE conv_id = :conv_id
      `,
      { conv_id: conversationId }
    );

    if (!rows.length) {
      return null;
    }

    let conversation = parseConversationRow(rows[0]);

    return (await this.getMessagesForConversations([conversation]))[0];
  }

  async findConversationsByDate(startDate, endDate) {
    await this.ensureDatabase();

    // TODO: Like in findConversationById, must support summaries.
    let rows = await this.#conn.executeCached(
      `
        SELECT conv_id, title, description, page_url,
          json(page_meta_jsonb) AS page_meta, created_date, updated_date,
          status, active_branch_tip_message_id
        FROM conversation
        WHERE updated_date >= :start_date AND updated_date <= :end_date
      `,
      { start_date: startDate, end_date: endDate }
    );
    if (!rows.length) {
      return [];
    }

    const conversations = rows.map(parseConversationRow);

    return await this.getMessagesForConversations(conversations);
  }

  async findConversationsByURL(pageUrl) {
    await this.ensureDatabase();

    // TODO: Like in findConversationById, must support summaries.
    let rows = await this.#conn.executeCached(
      `
        SELECT conv_id, title, description, page_url,
          json(page_meta_jsonb) AS page_meta, created_date, updated_date,
          status, active_branch_tip_message_id
        FROM conversation
        WHERE page_url = :page_url
      `,
      { page_url: pageUrl.href }
    );

    if (!rows.length) {
      return [];
    }
    const conversations = rows.map(parseConversationRow);

    return await this.getMessagesForConversations(conversations);
  }

  async getMessagesForConversations(conversations) {
    // Find all the messages for all the conversations.
    const rows = await this.#conn.executeCached(
      `
        SELECT
          message_id, created_date, parent_message_id, revision_root_message_id,
          ordinal, is_active_branch, role, model_id, conv_id,
          json(params_jsonb) As params, content, json(usage_jsonb) AS usage,
          page_url, turn_index
          FROM message
          WHERE conv_id IN(${new Array(conversations.length).fill("?").join(",")})
          ORDER BY ordinal ASC
      `,
      conversations.map(c => c.id)
    );

    let messages = parseMessageRows(rows);

    // TODO: retrieve TTL content.
    for (let conversation of conversations) {
      conversation.messages = messages.filter(m => {
        return m.conv_id == conversation.id;
      });
    }

    return conversations;
  }

  /**
   * Creates a 12 characters GUID with 72 bits of entropy.
   *
   * @returns {string} A base64url encoded GUID.
   */
  static makeGuid() {
    return ChromeUtils.base64URLEncode(
      lazy.CryptoUtils.generateRandomBytes(9),
      {
        pad: false,
      }
    );
  }
}

/**
 * Used to retrieve chat entries for the History app menu
 */
class RecentChatEntry {
  #id;
  #title;

  /**
   * @param {object} params
   * @param {string} params.conv_id
   * @param {string} params.title
   */
  constructor({ conv_id, title }) {
    this.#id = conv_id;
    this.#title = title;
  }

  get id() {
    return this.#id;
  }

  get title() {
    return this.#title;
  }
}

/**
 * A conversation containing messages.
 */
export class ChatHistoryConversation {
  id;
  title;
  description;
  pageUrl;
  pageMeta;
  createdDate;
  updatedDate;
  status;
  #messages;
  activeBranchTipMessageId;

  /**
   * @param {object} params
   * @param {string} [params.id]
   * @param {string} params.title
   * @param {string} params.description
   * @param {URL} params.pageUrl
   * @param {object} params.pageMeta
   * @param {number} [params.createdDate]
   * @param {number} [params.updatedDate]
   * @param {CONVERSATION_STATUS} [params.status]
   * @param {Array<ChatHistoryMessage>} [params.messages]
   */
  constructor({
    id = ChatHistory.makeGuid(),
    title,
    description,
    pageUrl,
    pageMeta,
    createdDate = Date.now(),
    updatedDate = Date.now(),
    status = ChatHistory.CONVERSATION_STATUS.ACTIVE,
    messages = [],
  }) {
    this.id = id;
    this.title = title;
    this.description = description;
    this.pageUrl = pageUrl;
    this.pageMeta = pageMeta;
    this.createdDate = createdDate;
    this.updatedDate = updatedDate;
    this.status = status;
    this.messages = messages;
  }

  updateActiveBranchTipMessageId() {
    this.activeBranchTipMessageId = this.messages
      .filter(m => m.isActiveBranch)
      .sort((a, b) => b.ordinal - a.ordinal)
      .shift()?.id;
  }

  /**
   * @param {ConversationRole} role - The type of conversation message
   * @param {string} content - The conversation message contents
   * @param {string} page_url - The current page url when message was submitted
   * @param {string} turn_index - The current conversation turn/cycle
   */
  addMessage(role, content, page_url, turn_index) {
    let parentMessageId = null;
    if (this?.messages?.length) {
      const lastMessageIndex = this.messages.length - 1;
      parentMessageId = this.messages[lastMessageIndex].id;
    }

    const currentMessages = this?.messages || [];
    const ordinal = currentMessages.length ? currentMessages.length + 1 : 1;

    const newMessage = new ChatHistoryMessage({
      parentMessageId,
      content,
      ordinal,
      page_url,
      turn_index,
      role,
    });

    this.messages.push(newMessage);
  }

  /**
   * @param {string} content - The user message content
   * @param {string?} pageUrl - The current page url when message was submitted
   * @param {number} [turn_index=0] - The conversation turn/cycle
   */
  addUserMessage(content, pageUrl = "", turn_index = 0) {
    this.addMessage(
      ChatHistory.MESSAGE_ROLE.USER,
      content,
      pageUrl,
      turn_index
    );
  }

  /**
   * @param {string} content - The assistant message content
   * @param {*} turn_index - The current conversation turn/cycle
   */
  addAssistantMessage(content, turn_index) {
    this.addMessage(
      ChatHistory.MESSAGE_ROLE.ASSISTANT,
      content,
      "",
      turn_index
    );
  }

  /**
   * Retrieves the list of visited sites during a conversation in visited order.
   *
   * @returns {Array<string>} - Ordered list of visited page URLs for this conversation
   */
  getSitesList() {
    const sites = new Set();

    this.messages.forEach(message => {
      if (message.page_url && isNotInternalUrl(message.page_url)) {
        sites.add(message.page_url);
      }
    });

    return Array.from(sites);
  }

  /**
   * Returns the most recently visited site during this conversation, or null
   * if no sites have been visited.
   *
   * @returns {string|null}
   */
  getMostRecentPageVisited() {
    const sites = this.getSitesList();

    return sites.length ? sites.pop() : null;
  }

  set messages(value) {
    this.#messages = value;
    this.updateActiveBranchTipMessageId();
  }

  get messages() {
    return this.#messages;
  }
}

// NOTE: This type of logic is used in several places, we should put
// this somewhere to be reused instead of redeclared in multiple places
function isNotInternalUrl(tabInfo) {
  if (!tabInfo) {
    return false;
  }

  const url = tabInfo.toLowerCase();

  // Filter out browser internal URLs
  return (
    (!url.startsWith("about:") || url.startsWith("about:reader?")) &&
    !url.startsWith("chrome:") &&
    !url.startsWith("moz-extension:") &&
    !url.startsWith("resource:") &&
    url !== "about:blank"
  );
}

/**
 * A message in a conversation.
 */
export class ChatHistoryMessage {
  id;
  createdDate;
  parentMessageId;
  revisionRootMessageId;
  ordinal;
  isActiveBranch;
  role;
  modelId;
  params;
  usage;
  content;
  conv_id;
  page_url;
  turn_index;

  /**
   * @param {object} param
   * @param {string} [param.id]
   * @param {number} [param.createdDate]
   * @param {string} [param.parentMessageId]
   * @param {string} [param.revisionRootMessageId]
   * @param {number} param.ordinal
   * @param {boolean} param.isActiveBranch
   * @param {MESSAGE_ROLE} param.role
   * @param {string} [param.modelId]
   * @param {object} [param.params]
   * @param {object} [param.usage]
   * @param {string} param.content
   * @param {string} param.conv_id
   * @param {string} param.page_url
   * @param {number} param.turn_index
   */
  constructor({
    id = ChatHistory.makeGuid(),
    createdDate = Date.now(),
    parentMessageId = null,
    revisionRootMessageId = null,
    ordinal,
    isActiveBranch = true,
    role,
    modelId = null,
    params = null,
    usage = null,
    content,
    conv_id = null,
    page_url,
    turn_index,
  }) {
    this.id = id;
    this.createdDate = createdDate;
    this.parentMessageId = parentMessageId;
    this.revisionRootMessageId = revisionRootMessageId;
    this.isActiveBranch = isActiveBranch;
    this.ordinal = ordinal;
    this.role = role;
    this.modelId = modelId;
    this.params = params;
    this.usage = usage;
    this.content = content;
    this.conv_id = conv_id;
    this.page_url = page_url;
    this.turn_index = turn_index;
  }

  static getRoleLabel(role) {
    switch (role) {
      case ChatHistory.MESSAGE_ROLE.USER:
        return "User";

      case ChatHistory.MESSAGE_ROLE.ASSISTANT:
        return "Assistant";

      case ChatHistory.MESSAGE_ROLE.SYSTEM:
        return "System";

      case ChatHistory.MESSAGE_ROLE.TOOL:
        return "Tool";
    }

    return "";
  }
}

/**
 * Try to parse a JSON string, returning null if it fails or the value is falsy.
 *
 * @param {string} value - The JSON string to parse.
 * @returns {object|null} The parsed object or null.
 */
function parseJSONOrNull(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

/**
 * Try to parse a URL string, returning null if it fails or the value is falsy.
 *
 * @param {string} value - The URL string to parse.
 * @returns {object|null} The parsed object or null.
 */
function parseURLOrNull(value) {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch (e) {
    return null;
  }
}

/**
 * Parse a conversation row from the database into a ChatHistoryConversation
 * object.
 *
 * @param {object} row - The database row to parse.
 * @returns {ChatHistoryConversation} The parsed conversation object.
 */
function parseConversationRow(row) {
  return new ChatHistoryConversation({
    id: row.getResultByName("conv_id"),
    title: row.getResultByName("title"),
    description: row.getResultByName("description"),
    pageUrl: parseURLOrNull(row.getResultByName("page_url")),
    pageMeta: parseJSONOrNull(row.getResultByName("page_meta")),
    createdDate: row.getResultByName("created_date"),
    updatedDate: row.getResultByName("updated_date"),
    status: row.getResultByName("status"),
  });
}

/**
 * Parse message rows from the database into an array of ChatHistoryMessage
 * objects.
 *
 * @param {object} rows - The database rows to parse.
 * @returns {Array<ChatHistoryMessage>} The parsed message objects.
 */
function parseMessageRows(rows) {
  return rows.map(row => {
    return new ChatHistoryMessage({
      id: row.getResultByName("message_id"),
      createdDate: row.getResultByName("created_date"),
      parentMessageId: row.getResultByName("parent_message_id"),
      revisionRootMessageId: row.getResultByName("revision_root_message_id"),
      ordinal: row.getResultByName("ordinal"),
      isActiveBranch: !!row.getResultByName("is_active_branch"),
      role: row.getResultByName("role"),
      modelId: row.getResultByName("model_id"),
      params: parseJSONOrNull(row.getResultByName("params")),
      usage: parseJSONOrNull(row.getResultByName("usage")),
      content: row.getResultByName("content"),
      conv_id: row.getResultByName("conv_id"),
      page_url: row.getResultByName("page_url"),
      turn_index: row.getResultByName("turn_index"),
    });
  });
}
