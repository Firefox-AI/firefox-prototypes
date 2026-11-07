/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Spotlight: "resource:///modules/asrouter/Spotlight.sys.mjs",
});

const ACCEPTED_TOPIC = "smartwindow-tou-accepted";

const MEMORIES_FROM_CONVERSATION_PREF =
  "browser.smartwindow.memories.generateFromConversation";
const MEMORIES_FROM_HISTORY_PREF =
  "browser.smartwindow.memories.generateFromHistory";

/**
 * Memory choices from the first-run memories screen. Model choice and the
 * "always open in Smart Window" checkbox are intentionally absent: model
 * selection is going away, and Smart Window does not become the default.
 */
const MEMORY_TILES = [
  {
    type: "confirmation-checklist",
    data: {
      inert: true,
      items: [
        {
          icon: {
            background:
              "center / contain no-repeat url('chrome://browser/content/aiwindow/assets/new-chat.svg')",
            height: "20px",
            width: "20px",
          },
          text: {
            string_id: "aiwindow-firstrun-memories-conversation-title",
            fontWeight: "600",
          },
          subtext: {
            string_id: "aiwindow-firstrun-memories-conversation-body",
          },
        },
        {
          icon: {
            background:
              "center / contain no-repeat url('chrome://global/skin/icons/settings.svg')",
            height: "20px",
            width: "20px",
          },
          text: {
            string_id: "aiwindow-firstrun-memories-relevance-title",
            fontWeight: "600",
          },
          subtext: {
            string_id: "aiwindow-firstrun-memories-relevance-body",
          },
        },
        {
          icon: {
            background:
              "center / contain no-repeat url('chrome://global/skin/icons/security.svg')",
            height: "20px",
            width: "20px",
          },
          text: {
            string_id: "aiwindow-firstrun-memories-privacy-title",
            fontWeight: "600",
          },
          subtext: {
            string_id: "aiwindow-firstrun-memories-privacy-body",
          },
        },
      ],
    },
  },
  {
    type: "multiselect",
    label: {
      string_id: "aiwindow-firstrun-memories-choose-label",
    },
    footer: {
      unCheckAllLabel: {
        string_id: "aiwindow-firstrun-memories-no-create",
      },
      checkedLabel: {
        string_id: "aiwindow-firstrun-memories-update-settings",
      },
    },
    data: [
      {
        id: "memories-chats",
        defaultValue: true,
        label: {
          string_id: "aiwindow-firstrun-memories-checkbox-chats",
        },
        action: {
          type: "SET_PREF",
          data: {
            pref: {
              name: MEMORIES_FROM_CONVERSATION_PREF,
              value: true,
            },
          },
        },
        uncheckedAction: {
          type: "SET_PREF",
          data: {
            pref: {
              name: MEMORIES_FROM_CONVERSATION_PREF,
              value: false,
            },
          },
        },
      },
      {
        id: "memories-browsing",
        defaultValue: true,
        label: {
          string_id: "aiwindow-firstrun-memories-checkbox-browsing",
        },
        action: {
          type: "SET_PREF",
          data: {
            pref: {
              name: MEMORIES_FROM_HISTORY_PREF,
              value: true,
            },
          },
        },
        uncheckedAction: {
          type: "SET_PREF",
          data: {
            pref: {
              name: MEMORIES_FROM_HISTORY_PREF,
              value: false,
            },
          },
        },
      },
    ],
  },
];

const TOU_GUEST_MESSAGE = {
  id: "AI_WINDOW_TOU_GUEST_MODAL",
  template: "spotlight",
  content: {
    template: "multistage",
    id: "AI_WINDOW_TOU_GUEST_MODAL",
    modal: "window",
    requireAction: true,
    disableEscClose: true,
    screens: [
      {
        id: "AI_WINDOW_TOU_GUEST_MODAL",
        content: {
          screen_style: {
            width: "720px",
          },
          logo: {
            height: "40px",
            width: "40",
          },
          title: {
            fontSize: "24px",
            string_id: "smartwindow-guest-tou-title",
          },
          subtitle: {
            string_id: "aiwindow-firstrun-memories-subtitle",
          },
          tiles_container: {
            position: "after_supporting_content",
          },
          above_button_content: [
            {
              type: "text",
              text: {
                string_id: "smartwindow-existing-user-fx-tou-body",
                fontSize: "13px",
                marginBlock: "10px 20px",
                marginInline: "20px",
              },
              link_keys: ["terms_of_use", "privacy_notice"],
              font_styles: "legal",
            },
          ],
          tiles: MEMORY_TILES,
          terms_of_use: {
            action: {
              type: "OPEN_URL",
              data: {
                where: "chromeless",
                args: "https://www.mozilla.org/about/legal/terms/smart-window/",
              },
            },
          },
          privacy_notice: {
            action: {
              type: "OPEN_URL",
              data: {
                where: "chromeless",
                args: "https://www.mozilla.org/privacy/smart-window/",
              },
            },
          },
          additional_button: {
            label: {
              string_id: "smartwindow-existing-user-fx-tou-accept",
              paddingBlock: "4px",
            },
            style: "primary",
            flow: "row",
            action: {
              type: "MULTI_ACTION",
              collectSelect: true,
              navigate: true,
              data: {
                orderedExecution: true,
                actions: [
                  {
                    type: "ACCEPT_SMARTWINDOW_TOU",
                  },
                ],
              },
            },
          },
          primary_button: {
            label: {
              string_id: "smartwindow-existing-user-fx-tou-go-back",
              paddingBlock: "4px",
            },
            style: "secondary",
            flow: "row",
            action: {
              dismiss: true,
            },
          },
        },
      },
    ],
  },
};

const GUEST_UNAVAILABLE_MESSAGE = {
  id: "AI_WINDOW_GUEST_UNAVAILABLE_MODAL",
  template: "spotlight",
  content: {
    template: "multistage",
    id: "AI_WINDOW_GUEST_UNAVAILABLE_MODAL",
    modal: "window",
    screens: [
      {
        id: "AI_WINDOW_GUEST_UNAVAILABLE_MODAL",
        content: {
          screen_style: {
            width: "585px",
          },
          logo: {
            height: "40px",
            width: "40",
          },
          title: {
            fontSize: "24px",
            string_id: "smartwindow-guest-unavailable-title",
          },
          above_button_content: [
            {
              type: "text",
              text: {
                string_id: "smartwindow-guest-unavailable-body",
                fontSize: "13px",
                marginBlock: "10px 20px",
                marginInline: "20px",
              },
              link_keys: ["sign_in"],
              font_styles: "legal",
            },
          ],
          sign_in: {
            action: {
              type: "MULTI_ACTION",
              data: {
                orderedExecution: true,
                actions: [
                  {
                    type: "FXA_SIGNIN_FLOW",
                    data: {
                      entrypoint: "smartwindow",
                      extraParams: {
                        service: "smartwindow",
                      },
                    },
                  },
                  {
                    type: "FXA_AIWINDOW_SIGNIN_FLOW",
                    requiresPrevious: true,
                  },
                ],
              },
              dismiss: true,
            },
          },
          primary_button: {
            label: {
              string_id: "smartwindow-guest-unavailable-ok",
              paddingBlock: "4px",
            },
            style: "primary",
            action: {
              dismiss: true,
            },
          },
        },
      },
    ],
  },
};

export const ToUSpotlight = {
  /**
   * Shows the Smart Window Terms of Use Spotlight modal.
   *
   * @param {Browser} browser
   * @returns {Promise<boolean>} Whether the user accepted
   */
  async show(browser) {
    let accepted = false;
    const observer = () => {
      accepted = true;
    };
    Services.obs.addObserver(observer, ACCEPTED_TOPIC);
    try {
      await lazy.Spotlight.showSpotlightDialog(browser, TOU_GUEST_MESSAGE);
    } finally {
      Services.obs.removeObserver(observer, ACCEPTED_TOPIC);
    }
    return accepted;
  },

  /**
   * Shows a Spotlight modal telling the user that Smart Window is temporarily
   * unavailable, after the guest sign-in failed.
   *
   * @param {Browser} browser
   * @returns {Promise<boolean>} Resolves to true once the modal has been
   *   dismissed, or to false if it could not be shown (e.g. another dialog is
   *   already open or the window is closed).
   */
  showUnavailable(browser) {
    return lazy.Spotlight.showSpotlightDialog(
      browser,
      GUEST_UNAVAILABLE_MESSAGE
    );
  },
};
