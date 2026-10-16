/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import "chrome://browser/content/aiwindow/components/smartwindow-onboarding.mjs";

const MODEL_OPTIONS = [
  {
    value: "4",
    l10nId: "aiwindow-firstrun-single-page-model-auto-label",
    descriptionL10nId: "aiwindow-firstrun-single-page-model-auto-description",
    buttonL10nId: "aiwindow-firstrun-single-page-model-auto-description",
  },
  {
    value: "3",
    l10nId: "aiwindow-firstrun-model-personal-label-v2",
    l10nArgs: { shortName: "Mistral Small 4" },
    descriptionL10nId: "aiwindow-firstrun-model-personal-body-v2",
  },
  {
    value: "1",
    l10nId: "aiwindow-firstrun-model-fast-label-v2",
    l10nArgs: { shortName: "Gemini 3.1 Flash Lite" },
    descriptionL10nId: "aiwindow-firstrun-model-fast-body-v2",
  },
  {
    value: "2",
    l10nId: "aiwindow-firstrun-model-flexible-label",
    l10nArgs: { shortName: "Qwen 3 235B" },
    descriptionL10nId: "aiwindow-firstrun-model-flexible-body",
  },
];

export default {
  title: "Domain-specific UI Widgets/AI Window/Onboarding",
  component: "smartwindow-onboarding",
  parameters: {
    fluent: `
aiwindow-firstrun-model-personal-label-v2 = Personal: { $shortName }
aiwindow-firstrun-model-personal-body-v2 = Built for personalized help across languages
aiwindow-firstrun-model-fast-label-v2 = Fast: { $shortName }
aiwindow-firstrun-model-fast-body-v2 = Best for quick answers when you’re moving fast
aiwindow-firstrun-model-flexible-label = Flexible: { $shortName }
aiwindow-firstrun-model-flexible-body = Ready for a variety of tasks
aiwindow-firstrun-single-page-title = Make it yours
aiwindow-firstrun-single-page-subtitle = You’ve got choices about how Smart Window works. Make changes anytime in settings.
aiwindow-firstrun-single-page-model-label = Which model?
aiwindow-firstrun-single-page-model-description = Models are what power chats and actions.
aiwindow-firstrun-single-page-model-auto-label = Auto model
aiwindow-firstrun-single-page-model-auto-description = Use the best model for the task
aiwindow-firstrun-single-page-personalize-label = Personalize Smart Window?
aiwindow-firstrun-single-page-personalize-description = Gives you a more tailored experience over time. You choose how it learns. Memories from learning are only stored on your device.
aiwindow-firstrun-single-page-personalize-chats = Learn from chats in Smart Window
aiwindow-firstrun-single-page-personalize-browsing = Learn from browsing across Firefox
aiwindow-firstrun-single-page-personalize-both = Learn from chats and browsing
aiwindow-firstrun-single-page-personalize-none = Don’t personalize or learn
aiwindow-firstrun-single-page-default-label = Make Smart Window your go-to?
aiwindow-firstrun-single-page-default-description = Open Smart Window when Firefox starts, restarts, or opens links from other apps.
aiwindow-firstrun-single-page-save-button = Save and continue
    `,
  },
  argTypes: {
    modelChoiceId: {
      options: MODEL_OPTIONS.map(option => option.value),
      control: { type: "select" },
    },
    memoriesChoice: {
      options: ["chats", "browsing", "both", "none"],
      control: { type: "select" },
    },
  },
};

const Template = ({ modelChoiceId, memoriesChoice, isDefaultWindow }) => html`
  <smartwindow-onboarding
    .modelOptions=${MODEL_OPTIONS}
    .modelChoiceId=${modelChoiceId}
    .memoriesChoice=${memoriesChoice}
    .isDefaultWindow=${isDefaultWindow}
  ></smartwindow-onboarding>
`;

export const Default = Template.bind({});
Default.args = {
  modelChoiceId: "4",
  memoriesChoice: "both",
  isDefaultWindow: true,
};

export const EuropePromotion = Template.bind({});
EuropePromotion.args = {
  modelChoiceId: "3",
  memoriesChoice: "both",
  isDefaultWindow: true,
};
