/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Installs extensions written by a conversation into its file storage, as
 * temporary add-ons. The files are copied out of the origin private file
 * system first, since the add-on manager only installs from the file system.
 *
 * Parent process only.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AIFiles:
    "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

export const ADDONS_DIRECTORY = "moz-ai-addons";

/**
 * @typedef {object} AddonSummary
 * @property {string} name - The name in the manifest.
 * @property {string} version - The version in the manifest.
 * @property {string[]} permissions - API permissions, host permissions and
 *   content script matches the extension asks for.
 */

/**
 * @param {object} manifest
 * @returns {AddonSummary}
 */
function summarize(manifest) {
  const permissions = new Set([
    ...(manifest.permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ]);
  for (const script of manifest.content_scripts ?? []) {
    for (const match of script.matches ?? []) {
      permissions.add(match);
    }
  }
  return {
    name: String(manifest.name ?? ""),
    version: String(manifest.version ?? ""),
    permissions: [...permissions].map(String),
  };
}

export const AIAddons = {
  /**
   * @param {string} contextId
   * @param {string} path - The directory holding manifest.json.
   * @returns {Promise<AddonSummary>}
   */
  async readManifest(contextId, path) {
    let text;
    try {
      text = await lazy.AIFiles.readTextFile(
        contextId,
        `${path}/manifest.json`
      );
    } catch (e) {
      throw new Error(`${path}/manifest.json could not be read: ${e.message}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      throw new Error(`${path}/manifest.json is not valid JSON: ${e.message}`);
    }
    if (!manifest || typeof manifest !== "object") {
      throw new Error(`${path}/manifest.json is not an object.`);
    }
    return summarize(manifest);
  },

  /**
   * The directory an extension of a context is installed from.
   *
   * @param {string} contextId
   * @param {string} path
   * @returns {string}
   */
  installPathFor(contextId, path) {
    // Validates both and keeps the path inside the context's directory.
    const url = new URL(lazy.AIFiles.urlFor(contextId, path));
    return PathUtils.join(
      PathUtils.profileDir,
      ADDONS_DIRECTORY,
      url.hostname,
      ...url.pathname.slice(1).split("/").map(decodeURIComponent)
    );
  },

  /**
   * Installs, or reinstalls with its current files, an extension of a context
   * as a temporary add-on, once the user agreed.
   *
   * @param {string} contextId
   * @param {string} path - The directory holding manifest.json.
   * @param {(summary: AddonSummary) => Promise<boolean>} confirm - Asks the
   *   user whether to install.
   * @returns {Promise<?{id: string, name: string, version: string}>} Null when
   *   the user declined.
   */
  async install(contextId, path, confirm) {
    const summary = await this.readManifest(contextId, path);
    if (!(await confirm(summary))) {
      return null;
    }

    const installPath = this.installPathFor(contextId, path);
    await lazy.AIFiles.exportDirectory(contextId, path, installPath);

    const addon = await lazy.AddonManager.installTemporaryAddon(
      new lazy.FileUtils.File(installPath)
    );
    return { id: addon.id, name: addon.name, version: addon.version };
  },
};
