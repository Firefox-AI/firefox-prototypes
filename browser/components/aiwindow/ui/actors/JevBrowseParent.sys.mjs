/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JevBrowseLoop:
    "moz-src:///browser/components/aiwindow/models/JevBrowseLoop.sys.mjs",
});

/**
 * Parent-side half of the Jev browse actor pair. The loop addresses the
 * owned browser's actor directly with sendQuery; the child never pushes
 * messages on its own, so anything arriving here is unsolicited and is only
 * counted (spec: `foreign_actor_messages`, expected 0).
 */
export class JevBrowseParent extends JSWindowActorParent {
  get browser() {
    return this.browsingContext?.top?.embedderElement ?? null;
  }

  receiveMessage() {
    lazy.JevBrowseLoop.noteUnsolicitedActorMessage(this.browser);
    return null;
  }
}
