/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ABOUT_SMARTWINDOW_URL =
  "chrome://browser/content/smartwindow/smartwindow.html";

export class AboutSmartWindow {
  static get aboutModuleInfo() {
    return {
      uri: "about:smartwindow",
      flags:
        Ci.nsIAboutModule.ALLOW_SCRIPT |
        Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD |
        Ci.nsIAboutModule.URI_CAN_LOAD_IN_PRIVILEGED_CHILD |
        Ci.nsIAboutModule.ENABLE_INDEXED_DB,
      messageNames: ["SmartWindow"],
    };
  }

  getURIFlags() {
    return AboutSmartWindow.aboutModuleInfo.flags;
  }

  newChannel(aURI, aLoadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(ABOUT_SMARTWINDOW_URL),
      aLoadInfo
    );
    channel.originalURI = aURI;
    return channel;
  }
}

export const SmartWindowActorConfig = {
  parent: {
    esModuleURI: "resource:///modules/smartwindow/SmartWindowParent.sys.mjs",
  },
  child: {
    esModuleURI: "resource:///modules/smartwindow/SmartWindowChild.sys.mjs",
    events: {
      DOMContentLoaded: {},
    },
  },
  matches: ["about:smartwindow"],
  remoteTypes: ["privilegedabout"],
};
