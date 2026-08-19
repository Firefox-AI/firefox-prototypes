/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function httpUrl(value) {
  const parsed = URL.parse(String(value ?? "").trim());
  if (parsed?.protocol == "https:" || parsed?.protocol == "http:") {
    return parsed.href;
  }
  return null;
}
