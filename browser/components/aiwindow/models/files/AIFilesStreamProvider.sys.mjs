/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIFiles:
    "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs",
});

/**
 * Provides the content of moz-ai URIs to MozAIProtocolHandler. The files are
 * read in the parent process; content processes ask for them through the
 * AIFiles process actor.
 *
 * @implements {nsIMozAIStreamProvider}
 */
export class AIFilesStreamProvider {
  QueryInterface = ChromeUtils.generateQI(["nsIMozAIStreamProvider"]);

  getStream(uri, callback) {
    this.#getFile(uri).then(
      ({ buffer, contentType }) => {
        const stream = Cc[
          "@mozilla.org/io/arraybuffer-input-stream;1"
        ].createInstance(Ci.nsIArrayBufferInputStream);
        stream.setData(buffer, 0, buffer.byteLength);
        callback.onStream(stream, contentType, buffer.byteLength);
      },
      error => {
        callback.onError(error?.result ?? Cr.NS_ERROR_FILE_NOT_FOUND);
      }
    );
  }

  async #getFile(uri) {
    if (
      Services.appinfo.processType === Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT
    ) {
      return lazy.AIFiles.getFileForURI(uri);
    }

    return ChromeUtils.domProcessChild
      .getActor("AIFiles")
      .sendQuery("AIFiles:GetFile", { spec: uri.spec });
  }
}
