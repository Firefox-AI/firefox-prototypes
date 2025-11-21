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
    template: "multistage",
    transitions: true,
    screens: [
      {
        id: "welcome_screen",
        content: {
          fullscreen: true,
          hide_secondary_section: "responsive",
          narrow: true,
          position: "split",

          title: {
            fontWeight: 600,
            fontSize: "55px",
            letterSpacing: "revert",
            raw: "Meet Smart Window a new way to browse",
          },
          title_style: "fancy shine",
          text_color: "dark",
          subtitle: {
            fontWeight: 400,
            raw: "Get answers when you need them. Keep your tabs tidy. Enjoy suggestions that feel made just for you. And because this is Firefox, your privacy always comes first.",
          },

          cta_paragraph: {
            text: {
              string_id: "genai-welcome-onboarding-tos",
            },
            action: {
              navigate: true,
            },
          },
          primary_button: {
            label: "Get Started",
            action: {
              type: "MULTI_ACTION",
              dismiss: true,
              data: {
                actions: [
                  {
                    data: {
                      entrypoint: "aimode",
                    },
                    type: "FXA_SMART_WINDOW_SIGNIN_FLOW",
                    navigate: true,
                  },
                ],
              },
            },
          },
          additional_button: {
            label: "Learn More",
            style: "link",
            action: {
              data: {
                args: "https://support.mozilla.org/",
                where: "tabshifted",
              },
              type: "OPEN_URL",
            },
          },
        },
      },
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
    () => renderMultistage(() => {}),
    { once: true }
  );
} else {
  renderMultistage(() => {});
}
