/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent side of the Browse Agent actor. The agent session drives the child
 * through sendQuery; nothing flows back unsolicited.
 */
export class BrowseAgentParent extends JSWindowActorParent {}
