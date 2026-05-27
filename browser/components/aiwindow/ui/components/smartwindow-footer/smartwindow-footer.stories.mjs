/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import "chrome://browser/content/aiwindow/components/smartwindow-footer.mjs";

export default {
  title: "Domain-specific UI Widgets/AI Window/Smartwindow Footer",
  component: "smartwindow-footer",
  parameters: {
    status: "in-development",
    docs: {
      description: {
        component:
          "A footer component for the Smart Window fullpage mode that provides navigation buttons for History, Chats, and Reports.",
      },
    },
    fluent: `
smartwindow-footer-history =
    .label = History
    .aria-label = View browsing history
    .tooltiptext = View your browsing history
smartwindow-footer-chats =
    .label = Chats
    .aria-label = View chat conversations
    .tooltiptext = View your chat conversations
smartwindow-footer-reports =
    .label = Reports
    .aria-label = View research reports
    .tooltiptext = View your research reports
    `,
  },
};

const Template = () => html`
  <div style="width: 400px; padding: 20px;">
    <smartwindow-footer></smartwindow-footer>
  </div>
`;

export const Default = Template.bind({});
Default.args = {};
