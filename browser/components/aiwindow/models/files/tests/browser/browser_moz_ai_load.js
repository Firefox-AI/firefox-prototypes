/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AIFiles } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs"
);

add_task(async function test_load_in_tab() {
  const id = crypto.randomUUID();
  await AIFiles.writeFile(
    id,
    "index.html",
    `<!doctype html><link rel="stylesheet" href="style.css"><h1>Ciao è</h1>`
  );
  await AIFiles.writeFile(id, "style.css", "h1 { color: rgb(255, 0, 0) }");

  const url = AIFiles.urlFor(id);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;

  const result = await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.readyState === "complete"
    );
    const h1 = content.document.querySelector("h1");
    const root = await content.navigator.storage.getDirectory();
    const opfs = [];
    for (const name of ["index.html", "style.css"]) {
      const file = await (await root.getFileHandle(name)).getFile();
      opfs.push(`${name}:${file.size}`);
    }
    return {
      principalOrigin: content.document.nodePrincipal.origin,
      isSecureContext: content.isSecureContext,
      opfs,
      origin: content.origin,
      text: h1?.textContent,
      color: h1 && content.getComputedStyle(h1).color,
    };
  });
  Assert.equal(result.principalOrigin, `moz-ai://${id}`);
  Assert.equal(result.origin, `moz-ai://${id}`);
  Assert.ok(result.isSecureContext);
  Assert.deepEqual(
    result.opfs,
    ["index.html:71", "style.css:28"],
    "The page sees the files of its conversation in its OPFS"
  );
  Assert.equal(result.text, "Ciao è");
  Assert.equal(result.color, "rgb(255, 0, 0)");
  Assert.equal(browser.remoteType, `webIsolated=moz-ai://${id}`);

  BrowserTestUtils.removeTab(tab);
  await AIFiles.clear(id);
});
