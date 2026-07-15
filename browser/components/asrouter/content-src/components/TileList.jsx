/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React from "react";
import { MultiStageUtils } from "../lib/multistage-utils.mjs";
import { Localized } from "./MSLocalized";

/**
 * Ordered or icon list of steps. Used inside single-select bodies and as a
 * top-level ContentTiles type (`tile-list` / `timeline`).
 *
 * content.items[]: { icon?, text, subtext? }
 * content.ordered / content.timeline: number steps instead of icons
 * content.style: limited inline styles on the container
 */
export const TileList = props => {
  const { content } = props;

  if (!content?.items?.length) {
    return null;
  }

  const CONFIGURABLE_STYLES = [
    "background",
    "borderRadius",
    "height",
    "marginBlock",
    "marginBlockStart",
    "marginBlockEnd",
    "marginInline",
    "paddingBlock",
    "paddingBlockStart",
    "paddingBlockEnd",
    "paddingInline",
    "paddingInlineStart",
    "paddingInlineEnd",
    "width",
  ];

  const ordered = !!(content.ordered || content.timeline);
  const containerClass = ordered
    ? "tile-list-container tile-list-timeline"
    : "tile-list-container";

  return (
    <div
      className={containerClass}
      style={MultiStageUtils.getValidStyle(content.style, CONFIGURABLE_STYLES)}
    >
      {content.items.map(({ icon, text, subtext }, index) => (
        <div
          key={index}
          className={
            ordered
              ? "tile-list-item tile-list-timeline-item"
              : "tile-list-item"
          }
        >
          <div className="tile-list-icon-wrapper">
            {ordered ? (
              <div className="tile-list-step-num" aria-hidden="true">
                {index + 1}
              </div>
            ) : (
              <div
                className="tile-list-icon"
                style={MultiStageUtils.getValidStyle(icon, CONFIGURABLE_STYLES)}
              />
            )}
          </div>
          <div className="tile-list-text">
            <Localized text={text}>
              <div className="text body-text tile-list-heading" />
            </Localized>
            {subtext ? (
              <Localized text={subtext}>
                <div className="tile-list-subtext" />
              </Localized>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
};
