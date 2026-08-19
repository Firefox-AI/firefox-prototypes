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

export function fieldsByRole(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const title = list.find(field => field.role == "title") || list[0];
  const subtitle = list.find(field => field.role == "subtitle");
  const image = list.find(
    field => field.role == "image" || field.type == "image"
  );
  const action = list.find(
    field => field.role == "action" || field.type == "url"
  );
  const details = list.filter(
    field =>
      field &&
      field !== title &&
      field !== subtitle &&
      field !== image &&
      field !== action
  );
  return { title, subtitle, image, action, details };
}
