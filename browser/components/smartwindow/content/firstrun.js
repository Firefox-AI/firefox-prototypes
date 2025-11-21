/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
const { topChromeWindow } = window.browsingContext;
const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

ChromeUtils.defineESModuleGetters(lazy, {
  AboutWelcomeParent: "resource:///actors/AboutWelcomeParent.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "onboardingConfig",
  "browser.smartwindow.onboarding.config",
  JSON.stringify({
    id: "smart-window-welcome",
    template: "spotlight",
    modal: "tab",
    transitions: true,
    backdrop: "linear-gradient(0deg, #D9C7F8 0%, #F6EEFC 102.21%)",
    screens: [
      {
        id: "welcome_screen",
        auto_advance: "additional_button",
        force_hide_steps_indicator: true,
        content: {
          fullscreen: true,
          hide_secondary_section: "responsive",
          narrow: true,
          position: "split",
          title: {
            fontWeight: 600,
            fontSize: "55px",
            width: "800px",
            textAlign: "center",
            raw: "Welcome to Smart Window",
          },
          title_style: "fancy shine",
          text_color: "dark",
          primary_button: {
            label: "Next",
            action: {
              navigate: true
            },
          },
        },
      },
      {
        id: "CHOOSE_MODEL",
        force_hide_steps_indicator: true,
        content: {
          fullscreen: true,
          hide_secondary_section: "responsive",
          narrow: true,
          position: "split",
          screen_style: {
            width: "650px",
            height: "500px",
          },
          title: {
            raw: "Pick a model to start 1",
          },
          subtitle: {
            raw: "You can switch anytime - and trying a few helps you find the best fit.",
          },
          tiles: {
            type: "single-select",
            autoTrigger: false,
            action: {
              picker: "<event>",
            },
            data: [
              {
                defaultValue: true,
                id: "model_1",
                icon: {
                  background:
                    "center / contain no-repeat url('https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/ms-images/733144c8-a453-49eb-aff7-27a10786fbc1.svg')",
                  marginBlockStart: "8px",

                },

                label: {
                  raw: "Fast & Clear",
                  fontSize: 17,
                  fontWeight: 600,
                },
                body: {
                  raw: "Quick answer to everyday questions",
                  color: "var(--text-color-deemphasized)",
                },
                action: {
                  type: "SET_PREF",
                  data: {
                    pref: {
                      name: "aidemo.model.choice",
                      value: "model_1",
                    },
                  },
                },
              },
              {
                id: "model_2",
                icon: {
                  background:
                    "center / contain no-repeat url('https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/ms-images/733144c8-a453-49eb-aff7-27a10786fbc1.svg')",
                  marginBlockStart: "8px",

                },
                label: {
                  raw: "Fast & Clear",
                  fontSize: 17,
                  fontWeight: 600,
                },
                body: {
                  raw: "Quick answer to everyday questions",
                  color: "var(--text-color-deemphasized)",
                },
                                action: {
                  type: "SET_PREF",
                  data: {
                    pref: {
                      name: "aidemo.model.choice",
                      value: "model_2",
                    },
                  },
                },
              },
              {
                id: "model_3",
                icon: {
                  background:
                    "center / contain no-repeat url('https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/ms-images/733144c8-a453-49eb-aff7-27a10786fbc1.svg')",
                  marginBlockStart: "8px",

                },
                label: {
                  raw: "Fast & Clear",
                  fontSize: 17,
                  fontWeight: 600,
                },
                body: {
                  raw: "Quick answer to everyday questions",
                  color: "var(--text-color-deemphasized)",
                },
                                action: {
                  type: "SET_PREF",
                  data: {
                    pref: {
                      name: "aidemo.model.choice",
                      value: "model_3",
                    },
                  },
                },
              }
            ]
          },
          primary_button: {
            label: {
              raw: "Next"
            },
            action: {
              navigate: true
            }
          },
        }
      },
      {
        id: "APPLY_INSIGHTS",
        content: {
          position: "center",
          screen_style: {
            width: "650px",
            height: "500px",
          },
          title: {
            raw: "Smarter browsing starts now",
          },
          subtitle: {
            raw: "Get personalized answers fast. Compare info across tabs. Find what you need in your history in your words, not keywords.",
          },
          above_button_content: [
            {
              type: "image",
              url: "chrome://browser/content/smartwindow/insights.png",
              width: "500px",
              height: "200px"
            }
          ],
          primary_button: {
            label: {
              raw: "Back"
            },
            action: {
              navigate: true,
              goBack: true
            }
          },
          additional_button: {
            label: "Let's Go",
            style: "primary",
            flow: "row",
            action: {
              navigate: true
            }
          },
        }
      }
    ],
  })
);

function addStylesheet(href) {
  const link = document.head.appendChild(document.createElement("link"));
  link.rel = "stylesheet";
  link.href = href;
}

function renderMultistage(ready) {
  const AWParent = new lazy.AboutWelcomeParent();
  const receive = name => data =>
    AWParent.onContentMessage(
      `AWPage:${name}`,
      data,
      topChromeWindow.gBrowser.selectedBrowser
    );

  // Expose top level functions expected by the bundle.
  window.AWGetFeatureConfig = () => JSON.parse(lazy.onboardingConfig);
  window.AWGetSelectedTheme = receive("GET_SELECTED_THEME");
  window.AWGetInstalledAddons = receive("GET_INSTALLED_ADDONS");
  window.AWSelectTheme = data => receive("SELECT_THEME")(data?.toUpperCase());
  window.AWSendEventTelemetry = receive("TELEMETRY_EVENT");

  window.AWSendToDeviceEmailsSupported = receive(
    "SEND_TO_DEVICE_EMAILS_SUPPORTED"
  );
  window.AWAddScreenImpression = receive("ADD_SCREEN_IMPRESSION");
  window.AWSendToParent = (name, data) => receive(name)(data);
  window.AWFinish = () => {
    window.close();
  };
  window.AWWaitForMigrationClose = receive("WAIT_FOR_MIGRATION_CLOSE");
  window.AWEvaluateScreenTargeting = receive("EVALUATE_SCREEN_TARGETING");
  window.AWEvaluateAttributeTargeting = receive("EVALUATE_ATTRIBUTE_TARGETING");

  // Update styling to be compatible with about:welcome.
  addStylesheet("chrome://browser/content/aboutwelcome/aboutwelcome.css");

  document.body.classList.add("onboardingContainer");
  document.body.id = "multi-stage-message-root";
  // This value is reported as the "page" in telemetry
  document.body.dataset.page = "smart-window-welcome";
  const bundleScript = document.head.appendChild(
    document.createElement("script")
  );
  bundleScript.src =
    "chrome://browser/content/aboutwelcome/aboutwelcome.bundle.js";

  ready();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => renderMultistage(() => { }),
    { once: true }
  );
} else {
  renderMultistage(() => { });
}
