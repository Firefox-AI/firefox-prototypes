/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Per-conversation file storage. Each conversation owns the origin
 * moz-ai://<conversation id>, and its files live in the origin private file
 * system of that origin, so QuotaManager handles quota and clearing. The same
 * files are served at moz-ai://<conversation id>/<path>.
 *
 * Parent process only.
 */

export const MOZ_AI_SCHEME = "moz-ai";

const CONTEXT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const UTF8_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/javascript",
]);

// Evaluated in the sandbox of a conversation, so that every file system call
// runs in the compartment owning the origin private file system. Only
// primitives cross the sandbox boundary, since the sandbox cannot see into
// objects of the caller.
const SANDBOX_SCRIPT = `
  async function getParent(segments, create) {
    let dir = await storage.getDirectory();
    for (const segment of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }

  async function walk(dir, prefix, result) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        await walk(handle, prefix + name + "/", result);
      } else {
        const file = await handle.getFile();
        result.push({ path: prefix + name, size: file.size });
      }
    }
    return result;
  }

  this.aiFiles = {
    async write(path, contents) {
      const segments = path.split("/");
      const dir = await getParent(segments, true);
      const handle = await dir.getFileHandle(segments.at(-1), { create: true });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
      return (await handle.getFile()).size;
    },

    async read(path) {
      const segments = path.split("/");
      const dir = await getParent(segments, false);
      const handle = await dir.getFileHandle(segments.at(-1));
      return (await handle.getFile()).arrayBuffer();
    },

    async remove(path) {
      const segments = path.split("/");
      const dir = await getParent(segments, false);
      await dir.removeEntry(segments.at(-1), { recursive: true });
    },

    async list() {
      return JSON.stringify(await walk(await storage.getDirectory(), "", []));
    },
  };
`;

const sandboxes = new Map();

/**
 * @param {string} contextId
 * @returns {nsIPrincipal}
 */
function principalFor(contextId) {
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`${MOZ_AI_SCHEME}://${contextId}/`),
    {}
  );
}

function validateContextId(contextId) {
  if (typeof contextId !== "string" || !CONTEXT_ID_REGEX.test(contextId)) {
    throw new Error(`Invalid AI context id: ${contextId}`);
  }
}

/**
 * The functions of SANDBOX_SCRIPT, bound to the sandbox of a context.
 *
 * @param {string} contextId
 */
function getSandboxFiles(contextId) {
  validateContextId(contextId);

  let sandbox = sandboxes.get(contextId);
  if (!sandbox) {
    sandbox = Cu.Sandbox(principalFor(contextId), {
      sandboxName: `${MOZ_AI_SCHEME}://${contextId}`,
      wantGlobalProperties: ["storage"],
      forceSecureContext: true,
    });
    Cu.evalInSandbox(SANDBOX_SCRIPT, sandbox);
    sandboxes.set(contextId, sandbox);
  }
  return Cu.waiveXrays(sandbox).aiFiles;
}

/**
 * Validates a relative path and splits it into file system entry names.
 *
 * @param {string} path - e.g. "pages/index.html".
 * @returns {string[]}
 */
function splitPath(path) {
  if (typeof path !== "string") {
    throw new Error("The path must be a string.");
  }

  const segments = path.replace(/^\/+/, "").split("/");
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new Error(`Invalid path: ${path}`);
    }
  }
  return segments;
}

function contentTypeFor(path) {
  const extension = path.includes(".") ? path.split(".").pop() : "";
  let contentType = DEFAULT_CONTENT_TYPE;
  if (extension) {
    try {
      contentType = Cc["@mozilla.org/mime;1"]
        .getService(Ci.nsIMIMEService)
        .getTypeFromExtension(extension);
    } catch {}
  }
  if (contentType.startsWith("text/") || UTF8_CONTENT_TYPES.has(contentType)) {
    contentType += ";charset=utf-8";
  }
  return contentType;
}

export const AIFiles = {
  /**
   * @param {string} contextId
   * @param {string} [path]
   * @returns {string} The moz-ai URL of a file of a context.
   */
  urlFor(contextId, path = "") {
    validateContextId(contextId);
    const encoded = path
      ? splitPath(path).map(encodeURIComponent).join("/")
      : "";
    return `${MOZ_AI_SCHEME}://${contextId}/${encoded}`;
  },

  /**
   * Creates or replaces a file.
   *
   * @param {string} contextId
   * @param {string} path
   * @param {string} contents - Stored as UTF-8.
   * @returns {Promise<{url: string, size: number}>}
   */
  async writeFile(contextId, path, contents) {
    const size = await getSandboxFiles(contextId).write(
      splitPath(path).join("/"),
      String(contents)
    );
    return { url: this.urlFor(contextId, path), size };
  },

  /**
   * @param {string} contextId
   * @param {string} path
   * @returns {Promise<ArrayBuffer>}
   */
  async readFile(contextId, path) {
    const buffer = await getSandboxFiles(contextId).read(
      splitPath(path).join("/")
    );
    // Copies the buffer out of the sandbox compartment.
    return structuredClone(buffer);
  },

  /**
   * @param {string} contextId
   * @param {string} path
   * @returns {Promise<string>}
   */
  async readTextFile(contextId, path) {
    return new TextDecoder().decode(await this.readFile(contextId, path));
  },

  /**
   * @param {string} contextId
   * @param {string} path - A file or a directory, removed with its content.
   */
  async removeFile(contextId, path) {
    await getSandboxFiles(contextId).remove(splitPath(path).join("/"));
  },

  /**
   * @param {string} contextId
   * @returns {Promise<Array<{path: string, size: number}>>}
   */
  async listFiles(contextId) {
    return JSON.parse(await getSandboxFiles(contextId).list());
  },

  /**
   * Copies a directory of a context to the file system, replacing the content
   * of the target directory.
   *
   * @param {string} contextId
   * @param {string} path - The directory to copy, e.g. "add-ons/foo".
   * @param {string} targetPath - Absolute path of the target directory.
   * @returns {Promise<number>} The number of files copied.
   */
  async exportDirectory(contextId, path, targetPath) {
    const prefix = splitPath(path).join("/") + "/";
    const files = (await this.listFiles(contextId)).filter(f =>
      f.path.startsWith(prefix)
    );

    await IOUtils.remove(targetPath, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(targetPath);

    for (const file of files) {
      const segments = file.path.slice(prefix.length).split("/");
      const target = PathUtils.join(targetPath, ...segments);
      await IOUtils.makeDirectory(PathUtils.parent(target));
      const buffer = await this.readFile(contextId, file.path);
      await IOUtils.write(target, new Uint8Array(buffer));
    }
    return files.length;
  },

  /**
   * Resolves a moz-ai URI to the content of the file it names. A URI naming a
   * directory resolves to the index.html file it contains.
   *
   * @param {nsIURI} uri
   * @returns {Promise<{buffer: ArrayBuffer, contentType: string}>}
   */
  async getFileForURI(uri) {
    if (!uri.schemeIs(MOZ_AI_SCHEME)) {
      throw new Error(`Not a ${MOZ_AI_SCHEME} URI: ${uri.spec}`);
    }

    const url = uri.QueryInterface(Ci.nsIURL);
    let path = url.filePath
      .split("/")
      .map(segment => decodeURIComponent(segment))
      .join("/");
    if (path.endsWith("/")) {
      path += "index.html";
    }

    const buffer = await this.readFile(uri.host, path);
    return { buffer, contentType: contentTypeFor(path) };
  },

  /**
   * Deletes every file of a context.
   *
   * @param {string} contextId
   */
  async clear(contextId) {
    validateContextId(contextId);

    const sandbox = sandboxes.get(contextId);
    if (sandbox) {
      sandboxes.delete(contextId);
      Cu.nukeSandbox(sandbox);
    }

    const request = Services.qms.clearStoragesForPrincipal(
      principalFor(contextId)
    );
    await new Promise((resolve, reject) => {
      request.callback = () => {
        if (request.resultCode === Cr.NS_OK) {
          resolve();
        } else {
          reject(
            new Components.Exception("Clearing failed", request.resultCode)
          );
        }
      };
    });
  },
};
