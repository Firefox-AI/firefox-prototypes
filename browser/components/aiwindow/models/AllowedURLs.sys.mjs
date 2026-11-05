/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Allow list of URL protocols for tabs and pages exposed to the LLM. Only http/https are
// permitted; internal (about:, chrome:, moz-extension:, file:, data:, etc.)
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Whether a URL uses an http(s) protocol, the only protocols permitted to be
 * exposed to the language model. Note this checks the protocol only, not
 * whether the specific URL is otherwise safe to expose.
 *
 * Important! Changing or removing this allow list requires a security review.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedURLProtocol(url) {
  return ALLOWED_URL_PROTOCOLS.has(URL.parse(url)?.protocol);
}
