/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { AuthProviderImpl } from "moz-src:///browser/components/aiwindow/models/auth/AuthProviderImpl.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  FxAccounts: "resource://gre/modules/FxAccounts.sys.mjs",
  getFxAccountsSingleton: "resource://gre/modules/FxAccounts.sys.mjs",
  OAUTH_CLIENT_ID: "resource://gre/modules/FxAccountsCommon.sys.mjs",
  ONLOGOUT_NOTIFICATION: "resource://gre/modules/FxAccountsCommon.sys.mjs",
  SCOPE_PROFILE_UID: "resource://gre/modules/FxAccountsCommon.sys.mjs",
  SCOPE_SMART_WINDOW: "resource://gre/modules/FxAccountsCommon.sys.mjs",
  SpecialMessageActions:
    "resource://messaging-system/lib/SpecialMessageActions.sys.mjs",
  log: () =>
    console.createInstance({
      prefix: "FxaAuthProviderImpl",
      maxLogLevel: Services.prefs.getBoolPref("browser.smartwindow.log", false)
        ? "Debug"
        : "Warn",
    }),
});

/**
 * AuthProviderImpl backed by Mozilla accounts.
 */
export class FxaAuthProviderImpl extends AuthProviderImpl {
  constructor() {
    super();
    Services.obs.addObserver(
      () => this.dispatchEvent(new Event("AuthProviderImpl:Logout")),
      lazy.ONLOGOUT_NOTIFICATION
    );
  }

  async getToken() {
    try {
      const fxAccounts = lazy.getFxAccountsSingleton();
      return await fxAccounts.getOAuthToken({
        scope: [lazy.SCOPE_SMART_WINDOW, lazy.SCOPE_PROFILE_UID],
        client_id: lazy.OAUTH_CLIENT_ID,
      });
    } catch (error) {
      console.warn("Error obtaining FxA token:", error);
      return null;
    }
  }

  async invalidateToken(token) {
    const fxAccounts = lazy.getFxAccountsSingleton();
    await fxAccounts.removeCachedOAuthToken({ token });
  }

  async isSignedIn() {
    try {
      const fxAccounts = lazy.getFxAccountsSingleton();
      return !!(await fxAccounts.getSignedInUser());
    } catch (error) {
      lazy.log.error("Error checking sign-in status:", error);
      return false;
    }
  }

  async canSignIn() {
    return lazy.FxAccounts.canConnectAccount();
  }

  async signIn(browser) {
    return lazy.SpecialMessageActions.fxaSignInFlow(
      {
        autoClose: Services.prefs.getBoolPref(
          "browser.smartwindow.firstrun.hasCompleted",
          false
        ),
        entrypoint: "smartwindow",
        extraParams: {
          service: "smartwindow",
        },
      },
      browser
    );
  }
}
