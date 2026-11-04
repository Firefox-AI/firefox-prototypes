/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_ENABLED = "browser.smartwindow.dailyDigest.enabled";
const PREF_INFERRED_TOPIC = "browser.smartwindow.dailyDigest.inferredTopic";
const PREF_FOLLOWED_TOPICS = "browser.smartwindow.dailyDigest.followedTopics";

export const DIGEST_FREQUENCY = Object.freeze({
  DAILY: "daily",
  WEEKLY: "weekly",
});

export const DIGEST_LENGTH = Object.freeze({
  SHORT: "short",
  STANDARD: "standard",
  DETAILED: "detailed",
});

/**
 * @typedef {object} CuratedDigestTopic
 * @property {string} id
 * @property {string} titleL10nId
 * @property {string} coverL10nId
 * @property {string} memoryL10nId - Label for the "Based on memory" chip.
 * @property {string[]} sources - Domains the digest pulls content from.
 */

/**
 * The topics offered by the "Follow a topic" dropdown. Custom topics are out
 * of scope for v0.
 *
 * @type {ReadonlyArray<CuratedDigestTopic>}
 */
export const CURATED_DIGEST_TOPICS = Object.freeze([
  {
    id: "top-news",
    titleL10nId: "aiwindow-digest-topic-top-news",
    coverL10nId: "aiwindow-digest-topic-top-news-cover",
    memoryL10nId: "aiwindow-digest-topic-top-news-memory",
    sources: ["bbc.com", "reuters.com"],
  },
  {
    id: "nutrition",
    titleL10nId: "aiwindow-digest-topic-nutrition",
    coverL10nId: "aiwindow-digest-topic-nutrition-cover",
    memoryL10nId: "aiwindow-digest-topic-nutrition-memory",
    sources: ["bbc.com", "health.harvard.edu"],
  },
  {
    id: "zero-waste-cooking",
    titleL10nId: "aiwindow-digest-topic-zero-waste",
    coverL10nId: "aiwindow-digest-topic-zero-waste-cover",
    memoryL10nId: "aiwindow-digest-topic-zero-waste-memory",
    sources: ["seriouseats.com", "theguardian.com"],
  },
]);

/**
 * @typedef {object} FollowedDigestTopic
 * @property {string} id
 * @property {string} title
 * @property {string} cover
 * @property {string[]} sources
 * @property {string} frequency - One of DIGEST_FREQUENCY.
 * @property {string} time - "HH:MM", 24-hour.
 * @property {string} length - One of DIGEST_LENGTH.
 * @property {number} followedAt
 */

export const DailyDigest = {
  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  },

  /**
   * The high-confidence topic used for the default "Catch up on" pill.
   *
   * TODO: derive this from inferred interests in memories instead of a pref.
   *
   * @returns {string}
   */
  get inferredTopic() {
    return Services.prefs.getStringPref(PREF_INFERRED_TOPIC, "").trim();
  },

  /**
   * @returns {FollowedDigestTopic[]} Followed topics, most recent first.
   */
  getFollowedTopics() {
    try {
      const topics = JSON.parse(
        Services.prefs.getStringPref(PREF_FOLLOWED_TOPICS, "[]")
      );
      return Array.isArray(topics) ? topics : [];
    } catch {
      return [];
    }
  },

  isFollowing(id) {
    return this.getFollowedTopics().some(topic => topic.id === id);
  },

  /**
   * Saves a topic, replacing any previous setup with the same id.
   *
   * @param {Omit<FollowedDigestTopic, "followedAt">} topic
   * @returns {FollowedDigestTopic}
   */
  followTopic(topic) {
    const followed = { ...topic, followedAt: Date.now() };
    const topics = [
      followed,
      ...this.getFollowedTopics().filter(({ id }) => id !== topic.id),
    ];
    Services.prefs.setStringPref(PREF_FOLLOWED_TOPICS, JSON.stringify(topics));
    return followed;
  },

  unfollowTopic(id) {
    const topics = this.getFollowedTopics().filter(topic => topic.id !== id);
    Services.prefs.setStringPref(PREF_FOLLOWED_TOPICS, JSON.stringify(topics));
  },
};
