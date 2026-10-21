/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AIFiles } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const CONTEXT_ID = "0b6ef4a3-5a56-4f1c-9a5e-2f3f2c1d9e01";

function fetchURL(url) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadUsingSystemPrincipal: true,
  });
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream, status) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Components.Exception("Load failed", status));
        return;
      }
      const text = NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      });
      resolve({ text, contentType: channel.contentType, channel });
    });
  });
}

add_setup(function () {
  do_get_profile();
});

add_task(function test_uri() {
  const uri = Services.io.newURI(`moz-ai://${CONTEXT_ID}/dir/page.html`);
  Assert.equal(uri.scheme, "moz-ai");
  Assert.equal(uri.host, CONTEXT_ID);
  Assert.equal(uri.QueryInterface(Ci.nsIURL).filePath, "/dir/page.html");

  const principal = Services.scriptSecurityManager.createContentPrincipal(
    uri,
    {}
  );
  Assert.equal(principal.origin, `moz-ai://${CONTEXT_ID}`);
  Assert.ok(principal.isOriginPotentiallyTrustworthy);
});

add_task(async function test_write_read_list() {
  const { url, size } = await AIFiles.writeFile(
    CONTEXT_ID,
    "index.html",
    "<h1>Ciao è</h1>"
  );
  Assert.equal(url, `moz-ai://${CONTEXT_ID}/index.html`);
  Assert.equal(size, new TextEncoder().encode("<h1>Ciao è</h1>").length);

  await AIFiles.writeFile(CONTEXT_ID, "data/notes.md", "# notes");

  Assert.equal(
    await AIFiles.readTextFile(CONTEXT_ID, "index.html"),
    "<h1>Ciao è</h1>"
  );
  Assert.equal(
    await AIFiles.readTextFile(CONTEXT_ID, "data/notes.md"),
    "# notes"
  );

  const files = await AIFiles.listFiles(CONTEXT_ID);
  Assert.deepEqual(files.map(f => f.path).sort(), [
    "data/notes.md",
    "index.html",
  ]);
});

add_task(async function test_invalid_paths() {
  for (const path of ["", "../x", "a//b", "a/./b", "a\\b"]) {
    await Assert.rejects(
      AIFiles.writeFile(CONTEXT_ID, path, "x"),
      /Invalid path/,
      `${path} is rejected`
    );
  }
  await Assert.rejects(
    AIFiles.writeFile("not-a-uuid", "x.txt", "x"),
    /Invalid AI context id/
  );
});

add_task(async function test_channel() {
  let { text, contentType, channel } = await fetchURL(
    `moz-ai://${CONTEXT_ID}/index.html`
  );
  Assert.equal(text, "<h1>Ciao è</h1>");
  Assert.equal(contentType, "text/html");
  Assert.equal(channel.contentCharset, "utf-8");

  ({ text } = await fetchURL(`moz-ai://${CONTEXT_ID}/`));
  Assert.equal(text, "<h1>Ciao è</h1>", "A directory serves index.html");

  ({ text } = await fetchURL(`moz-ai://${CONTEXT_ID}/data/notes.md`));
  Assert.equal(text, "# notes");

  await Assert.rejects(
    fetchURL(`moz-ai://${CONTEXT_ID}/missing.html`),
    /Load failed/
  );
});

add_task(async function test_clear() {
  await AIFiles.clear(CONTEXT_ID);
  Assert.deepEqual(await AIFiles.listFiles(CONTEXT_ID), []);
});
