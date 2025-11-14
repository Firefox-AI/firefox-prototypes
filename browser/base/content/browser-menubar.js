/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { ChatHistory } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

// NOTE: Is this the best place for this, or where should this instance exist
const chatHistory = new ChatHistory();

document.addEventListener(
  "DOMContentLoaded",
  () => {
    let mainMenuBar = document.getElementById("main-menubar");

    mainMenuBar.addEventListener("command", event => {
      switch (event.target.id) {
        // == edit-menu ==
        case "menu_preferences":
          openPreferences(undefined);
          break;

        // == view-menu ==
        case "menu_pageStyleNoStyle":
          gPageStyleMenu.disableStyle();
          break;
        case "menu_pageStylePersistentOnly":
          gPageStyleMenu.switchStyleSheet(null);
          break;
        case "repair-text-encoding":
          BrowserCommands.forceEncodingDetection();
          break;
        case "enterFullScreenItem":
        case "exitFullScreenItem":
          BrowserCommands.fullScreen();
          break;
        case "documentDirection-swap":
          gBrowser.selectedBrowser.sendMessageToActor(
            "SwitchDocumentDirection",
            {},
            "SwitchDocumentDirection",
            "roots"
          );
          break;

        // == history-menu ==
        case "sync-tabs-menuitem":
          gSync.openSyncedTabsPanel();
          break;
        case "hiddenTabsMenu":
          gTabsPanel.showHiddenTabsPanel(event, "hidden-tabs-menuitem");
          break;
        case "sync-setup":
          gSync.openPrefs("menubar");
          break;
        case "sync-enable":
          gSync.openPrefs("menubar");
          break;
        case "sync-unverifieditem":
          gSync.openPrefs("menubar");
          break;
        case "sync-syncnowitem":
          gSync.doSync(event);
          break;
        case "sync-reauthitem":
          gSync.openSignInAgainPage("menubar");
          break;
        case "menu_openFirefoxView":
          FirefoxViewHandler.openTab();
          break;
        case "hiddenUndoCloseWindow":
          SessionWindowUI.undoCloseWindow(0);
          break;

        // == menu_HelpPopup ==
        // (Duplicated in PanelUI._onHelpCommand)
        case "menu_openHelp":
          openHelpLink("firefox-help");
          break;
        case "menu_layout_debugger":
          toOpenWindowByType(
            "mozapp:layoutdebug",
            "chrome://layoutdebug/content/layoutdebug.xhtml"
          );
          break;
        case "feedbackPage":
          openFeedbackPage();
          break;
        case "helpSafeMode":
          safeModeRestart();
          break;
        case "troubleShooting":
          openTroubleshootingPage();
          break;
        case "menu_HelpPopup_reportPhishingtoolmenu":
          openUILink(gSafeBrowsing.getReportURL("Phish"), event, {
            triggeringPrincipal:
              Services.scriptSecurityManager.createNullPrincipal({}),
          });
          break;
        case "menu_HelpPopup_reportPhishingErrortoolmenu":
          gSafeBrowsing.reportFalseDeceptiveSite();
          break;
        case "helpSwitchDevice":
          openSwitchingDevicesPage();
          break;
        case "aboutName":
          openAboutDialog();
          break;
        case "helpPolicySupport":
          openTrustedLinkIn(Services.policies.getSupportMenu().URL.href, "tab");
          break;
      }
    });

    document
      .getElementById("historyMenuPopup")
      .addEventListener("command", event => {
        // Handle commands/clicks on the descending menuitems that are
        // history entries.
        let historyMenu = document.getElementById("history-menu");
        historyMenu._placesView._onCommand(event);
      });

    let bookmarksMenuPopup = document.getElementById("bookmarksMenuPopup");
    bookmarksMenuPopup.addEventListener("command", event => {
      BookmarksEventHandler.onCommand(event);
    });

    bookmarksMenuPopup.addEventListener("click", event => {
      BookmarksEventHandler.onClick(
        event,
        bookmarksMenuPopup.parentNode._placesView
      );
    });

    bookmarksMenuPopup.addEventListener("mouseup", event => {
      BookmarksEventHandler.onMouseUp(event);
    });

    const bookmarksMenu = document.getElementById("bookmarksMenu");
    bookmarksMenu.addEventListener("dragover", event =>
      PlacesMenuDNDHandler.onDragOver(event)
    );
    bookmarksMenu.addEventListener("dragenter", event =>
      PlacesMenuDNDHandler.onDragEnter(event)
    );
    bookmarksMenu.addEventListener("dragleave", event =>
      PlacesMenuDNDHandler.onDragLeave(event)
    );
    bookmarksMenu.addEventListener("drop", event =>
      PlacesMenuDNDHandler.onDrop(event)
    );

    mainMenuBar.addEventListener("popupshowing", event => {
      // On macOS, we don't track whether activation of the native menubar happened
      // with the keyboard.
      if (AppConstants.platform != "macosx") {
        // We only set the "openedwithkey" if a specific menu like "Edit" was opened
        // instead of the general menu bar. (e.g. Alt+E instead of just Alt)
        if (event.target.parentNode.parentNode == this) {
          this.setAttribute(
            "openedwithkey",
            event.target.parentNode.openedWithKey
          );
        }
      }

      switch (event.target.id) {
        case "menu_FilePopup":
          gFileMenu.onPopupShowing(event);
          break;
        case "menu_newUserContextPopup":
          createUserContextMenu(event);
          break;
        case "menu_EditPopup":
          updateEditUIVisibility();
          break;
        case "view-menu-popup":
          ToolbarContextMenu.onViewToolbarsPopupShowing(event);
          break;
        case "pageStyleMenuPopup":
          gPageStyleMenu.fillPopup(event.target);
          break;
        case "historyMenuPopup":
          if (!event.target.parentNode._placesView) {
            new HistoryMenu(event);
          }

          addSmartWindowOptions(event.target);
          break;
        case "historyUndoPopup":
          document
            .getElementById("history-menu")
            ._placesView.populateUndoSubmenu();
          break;
        case "historyUndoWindowPopup":
          document
            .getElementById("history-menu")
            ._placesView.populateUndoWindowSubmenu();
          break;
        case "bookmarksMenuPopup":
          BookmarkingUI.onMainMenuPopupShowing(event);
          if (!event.target.parentNode._placesView) {
            new PlacesMenu(
              event,
              `place:parent=${PlacesUtils.bookmarks.menuGuid}`
            );
          }
          break;
        case "bookmarksToolbarFolderPopup":
          if (!event.target.parentNode._placesView) {
            new PlacesMenu(
              event,
              `place:parent=${PlacesUtils.bookmarks.toolbarGuid}`
            );
          }
          break;
        case "otherBookmarksFolderPopup":
          if (!event.target.parentNode._placesView) {
            new PlacesMenu(
              event,
              `place:parent=${PlacesUtils.bookmarks.unfiledGuid}`
            );
          }
          break;
        case "mobileBookmarksFolderPopup":
          if (!event.target.parentNode._placesView) {
            new PlacesMenu(
              event,
              `place:parent=${PlacesUtils.bookmarks.mobileGuid}`
            );
          }
          break;
        case "menu_HelpPopup":
          buildHelpMenu();
          break;
        case "menu_ProfilesPopup":
          gProfiles.onPopupShowing(event);
          break;
      }
    });

    document
      .getElementById("menu_EditPopup")
      .addEventListener("popuphidden", () => {
        updateEditUIVisibility();
      });
  },
  { once: true }
);

function addSmartWindowOptions(menu) {
  addChatsOption(menu);
  addRecentChats(menu);
}

async function addChatsOption(menu) {
  removeChatsOption();

  const smartWindowActive = SmartWindow?.isSmartWindowActive?.();
  if (smartWindowActive) {
    await addChatsOptionMenuItem(menu);
  }
}

function removeChatsOption() {
  const chatsOption = document.getElementById("menu_chats");
  chatsOption?.remove?.();
}

async function addChatsOptionMenuItem(menu) {
  const clearRecentHistory = document.getElementById("sanitizeItem");

  const menuItem = document.createXULElement("menuitem");
  menuItem.classList.add("chat-history-option");

  menuItem.setAttribute("id", "menu_chats");
  menuItem.setAttribute("key", "chats");
  menuItem.setAttribute("command", "View:Chats");
  menuItem.setAttribute("data-l10n-id", "menu-history-chats");

  menu.insertBefore(menuItem, clearRecentHistory);
}

async function addRecentChats(menu) {
  const startMarker = document.getElementById("startChatHistorySeparator");
  const endMarker = document.getElementById("endChatHistorySeparator");
  removeChatsMenuOptions(startMarker, endMarker);

  const smartWindowActive = SmartWindow?.isSmartWindowActive?.();
  if (smartWindowActive) {
    await addRecentChatsHeader(menu, endMarker);

    const items = await chatHistory.findRecentConversations(4);

    if (items.length === 0) {
      removeChatsMenuOptions(startMarker, endMarker);
      return;
    }

    addRecentChatItems(menu, items, endMarker);
  }
}

async function addRecentChatsHeader(menu, endMarker) {
  const menuItem = document.createXULElement("menuitem");
  menuItem.classList.add("recent-chat-header");

  menuItem.setAttribute("data-l10n-id", "menu-history-chats-recent");
  menuItem.setAttribute("disabled", true);

  menu.insertBefore(menuItem, endMarker);
}

function removeChatsMenuOptions(startMarker, endMarker) {
  clearRecentChats(startMarker, endMarker);
}

function addRecentChatItems(menu, items, endMarker) {
  for (const item of items) {
    const menuItem = document.createXULElement("menuitem");
    menuItem.classList.add("recent-chat-item");
    menuItem.setAttribute("label", item.title);

    // NOTE: what attribute should I use for this ID
    menuItem.setAttribute("targetURI", item.id);

    menuItem.addEventListener("command", async event => {
      const conv_id = event.target.getAttribute("targetURI");
      const conversation = await chatHistory.findConversationById(conv_id);

      if (!conversation) {
        return;
      }

      const lastVisitedSite = conversation.getMostRecentPageVisited();

      if (lastVisitedSite && isValidUrl(lastVisitedSite)) {
        gBrowser.selectedTab = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL);
        openUILink(lastVisitedSite, event, {
          triggeringPrincipal:
            Services.scriptSecurityManager.createNullPrincipal({}),
        });
      } else {
        gBrowser.selectedTab = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL);
      }

      // NOTE: This will need to change for prod as we manage
      // the conversation object somewhere else that is not
      // gBrowser.selectedTab
      gBrowser.selectedTab.conversation = conversation;

      setTimeout(() => {
        const chatBot =
          gBrowser?.selectedBrowser?.contentDocument?.querySelector?.(
            "#chat-bot"
          );

        if (chatBot.conversation.id !== conversation.id) {
          chatBot.conversation = conversation;
        }

        chatBot.scrollToBottom();
        chatBot.requestUpdate();
      }, 100);
    });

    menu.insertBefore(menuItem, endMarker);
  }
}

function isValidUrl(url) {
  return (
    (!url.startsWith("about:") || url.startsWith("about:reader?")) &&
    !url.startsWith("chrome:") &&
    !url.startsWith("moz-extension:") &&
    !url.startsWith("resource:") &&
    url !== "about:blank"
  );
}

function clearRecentChats(startMarker, endMarker) {
  let next = startMarker?.nextSibling;
  while (next && next !== endMarker) {
    const toRemove = next;
    next = next.nextSibling;
    toRemove.remove();
  }
}
