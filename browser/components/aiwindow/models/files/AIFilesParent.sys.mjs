/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AIFiles,
  MOZ_AI_SCHEME,
} from "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs";

/**
 * Serves the files of moz-ai URIs to content processes. A process can only
 * read the files of the origin it is isolated to.
 */
export class AIFilesParent extends JSProcessActorParent {
  receiveMessage({ name, data }) {
    if (name !== "AIFiles:GetFile") {
      return Promise.reject(new Error(`Unknown message: ${name}`));
    }

    const uri = Services.io.newURI(data.spec);
    if (!uri.schemeIs(MOZ_AI_SCHEME)) {
      return Promise.reject(new Error("Not a moz-ai URI"));
    }

    const expected = `webIsolated=${uri.prePath}`;
    const { remoteType } = this.manager;
    if (remoteType !== expected && !remoteType?.startsWith(`${expected}^`)) {
      return Promise.reject(new Error("Process type mismatch"));
    }

    return AIFiles.getFileForURI(uri);
  }
}
