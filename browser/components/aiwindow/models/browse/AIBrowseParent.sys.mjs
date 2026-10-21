/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The parent side of AIBrowseChild. AIBrowse sends it messages for the tabs of
 * its browsing sessions only.
 */
export class AIBrowseParent extends JSWindowActorParent {}
