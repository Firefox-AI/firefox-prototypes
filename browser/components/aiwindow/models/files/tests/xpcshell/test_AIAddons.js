/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { AIAddons } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/files/AIAddons.sys.mjs"
);
const { AIFiles } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/files/AIFiles.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "42"
);

const CONTEXT_ID = "6f1c2a0e-8d3b-4c55-9b7e-0a1d2c3e4f50";
const ADDON_ID = "counter@moz-ai.test";
const PATH = "add-ons/counter";

function manifest(version, extra = {}) {
  return JSON.stringify({
    manifest_version: 3,
    name: "Counter",
    version,
    browser_specific_settings: { gecko: { id: ADDON_ID } },
    background: { scripts: ["background.js"] },
    permissions: ["tabs"],
    host_permissions: ["https://example.com/*"],
    ...extra,
  });
}

add_setup(async function () {
  await AddonTestUtils.promiseStartupManager();
});

add_task(async function test_read_manifest() {
  await AIFiles.writeFile(CONTEXT_ID, `${PATH}/manifest.json`, manifest("1.0"));
  await AIFiles.writeFile(CONTEXT_ID, `${PATH}/background.js`, "// v1");

  Assert.deepEqual(await AIAddons.readManifest(CONTEXT_ID, PATH), {
    name: "Counter",
    version: "1.0",
    permissions: ["tabs", "https://example.com/*"],
  });
});

add_task(async function test_declined() {
  let summary = null;
  const result = await AIAddons.install(CONTEXT_ID, PATH, async s => {
    summary = s;
    return false;
  });
  Assert.equal(result, null);
  Assert.equal(summary.name, "Counter");
  Assert.equal(await AddonManager.getAddonByID(ADDON_ID), null);
  Assert.ok(
    !(await IOUtils.exists(AIAddons.installPathFor(CONTEXT_ID, PATH))),
    "Nothing is exported when the user declines"
  );
});

add_task(async function test_install_and_reinstall() {
  const result = await AIAddons.install(CONTEXT_ID, PATH, async () => true);
  Assert.deepEqual(result, { id: ADDON_ID, name: "Counter", version: "1.0" });

  let addon = await AddonManager.getAddonByID(ADDON_ID);
  Assert.ok(addon.isActive);
  Assert.ok(addon.temporarilyInstalled);

  const installPath = AIAddons.installPathFor(CONTEXT_ID, PATH);
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(installPath, "background.js")),
    "// v1"
  );

  await AIFiles.writeFile(CONTEXT_ID, `${PATH}/manifest.json`, manifest("2.0"));
  await AIFiles.writeFile(CONTEXT_ID, `${PATH}/background.js`, "// v2");
  await AIAddons.install(CONTEXT_ID, PATH, async () => true);

  addon = await AddonManager.getAddonByID(ADDON_ID);
  Assert.equal(addon.version, "2.0");
  Assert.ok(addon.isActive);
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(installPath, "background.js")),
    "// v2"
  );

  await addon.uninstall();
});

add_task(async function test_errors() {
  await Assert.rejects(
    AIAddons.install(CONTEXT_ID, "add-ons/missing", async () => true),
    /manifest\.json could not be read/
  );

  await AIFiles.writeFile(CONTEXT_ID, "add-ons/broken/manifest.json", "{");
  await Assert.rejects(
    AIAddons.install(CONTEXT_ID, "add-ons/broken", async () => true),
    /not valid JSON/
  );

  await AIFiles.writeFile(
    CONTEXT_ID,
    "add-ons/invalid/manifest.json",
    JSON.stringify({ name: "Invalid" })
  );
  await Assert.rejects(
    AIAddons.install(CONTEXT_ID, "add-ons/invalid", async () => true),
    /./,
    "The add-on manager rejects an invalid manifest"
  );
});
