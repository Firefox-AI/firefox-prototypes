/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class SmartWindowChild extends JSWindowActorChild {
  actorCreated() {
    this.contentWindow.addEventListener("DOMContentLoaded", this);
  }

  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
        this.setupContentListeners();
        break;
    }
  }

  setupContentListeners() {}

  receiveMessage(message) {
    switch (message.name) {
      case "SmartWindow:Ready":
        this.sendAsyncMessage("SmartWindow:PageReady");
        break;

      case "SmartWindow:Search":
        this.sendAsyncMessage("SmartWindow:DoSearch", message.data);
        break;

      case "SmartWindow:Navigate":
        this.sendAsyncMessage("SmartWindow:DoNavigate", message.data);
        break;

      case "SmartWindow:UpdateResults":
        this.contentWindow.dispatchEvent(
          new this.contentWindow.CustomEvent("SmartWindowMessage", {
            detail: {
              type: "SearchResults",
              data: message.data.results,
            },
          })
        );
        break;

      case "SmartWindow:Clear":
        this.contentWindow.dispatchEvent(
          new this.contentWindow.CustomEvent("SmartWindowMessage", {
            detail: {
              type: "Clear",
            },
          })
        );
        break;

      case "SmartWindow:TabUpdate":
        // Send current tab info to the sidebar
        this.contentWindow.dispatchEvent(
          new this.contentWindow.CustomEvent("SmartWindowMessage", {
            detail: {
              type: "TabUpdate",
              data: message.data,
            },
          })
        );
        break;
    }
  }
}
