/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

do_get_profile();

const { getUserMemories } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

add_task(async function test_getUserMemories_returns_results() {
  const conversation = makeConversation();
  const result = await getUserMemories(conversation);

  Assert.ok(Array.isArray(result), "returns array, not a refusal");
});
