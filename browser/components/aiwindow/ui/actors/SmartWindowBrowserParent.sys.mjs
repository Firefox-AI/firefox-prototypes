/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent endpoint for Smart Window's browser-control actor.
 *
 * The model-side controller obtains this actor from a specific browser's
 * WindowGlobal and sends queries to the child. Keeping DOM access in the child
 * process avoids exposing arbitrary selectors or script execution to the model.
 */
export class SmartWindowBrowserParent extends JSWindowActorParent {}
