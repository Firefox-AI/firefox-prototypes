/* Smart Window auto grouping, extension prototype: background actor.
 *
 * Implements the "maintenance" flow of the logic spec (§5): every new tab that
 * finishes loading an http(s) page is classified once, ~2s later, strictly one
 * at a time. It JOINs a matching existing group, or CREATEs a new group when it
 * and at least two other loose tabs clearly belong together. Also §8.6/§8.7:
 * the toolbar menu toggle and "Undo last group".
 *
 * Not in this prototype: first-run triage, bulk confirm, correction callouts,
 * pause-after-corrections, preview groups, message bar, pulse/scroll motion.
 */
/* global browser, Classifier */

const DEFAULT_SETTINGS = {
  enabled: true,        // master switch (§8.7)
  joinDelayMs: 2000,    // §5.2 after-delay
  minClusterSize: 3,    // §3 minimum to create a new group (incl. trigger)
  threshold: 0.45,      // similarity threshold, same for JOIN and CREATE
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  lastCreatedGroupIds: [],   // §2, target of "Undo last group"
  groupOrigin: {},           // groupId -> "sw" (user-made groups are simply absent)
  exclusions: {},            // tabId -> groupId: never auto-add this tab to that group again
  log: [],                   // last few actions, for the popup
};

const pendingNewTabs = new Set();   // created this session, waiting for first real load
const timers = new Map();           // tabId -> timeout id
const autoAdded = new Map();        // tabId -> groupId the actor put it in (correction detection)
let queue = Promise.resolve();

// ---- persistence --------------------------------------------------------------
async function load() {
  const stored = await browser.storage.local.get(["settings", "lastCreatedGroupIds", "groupOrigin", "exclusions"]);
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  state.lastCreatedGroupIds = stored.lastCreatedGroupIds || [];
  state.groupOrigin = stored.groupOrigin || {};
  state.exclusions = stored.exclusions || {};
  // Groups and tabs do not survive a restart with the same ids; prune what is gone.
  try {
    const live = new Set((await browser.tabGroups.query({})).map(g => g.id));
    state.lastCreatedGroupIds = state.lastCreatedGroupIds.filter(id => live.has(id));
    for (const id of Object.keys(state.groupOrigin)) {
      if (!live.has(Number(id))) {
        delete state.groupOrigin[id];
      }
    }
    const liveTabs = new Set((await browser.tabs.query({})).map(t => t.id));
    for (const id of Object.keys(state.exclusions)) {
      if (!liveTabs.has(Number(id))) {
        delete state.exclusions[id];
      }
    }
  } catch (e) {
    console.warn("[auto-grouping] prune failed", e);
  }
  await persist();
}

function persist() {
  return browser.storage.local.set({
    settings: state.settings,
    lastCreatedGroupIds: state.lastCreatedGroupIds,
    groupOrigin: state.groupOrigin,
    exclusions: state.exclusions,
  });
}

function logAction(text) {
  const line = `${new Date().toLocaleTimeString()} ${text}`;
  state.log.unshift(line);
  state.log = state.log.slice(0, 8);
  console.info("[auto-grouping]", text);
}

// ---- helpers ----------------------------------------------------------------------
function isHttp(url) {
  return /^https?:\/\//.test(url || "");
}

function isLooseCandidate(tab) {
  return tab && !tab.pinned && tab.groupId === -1 && isHttp(tab.url) && !tab.incognito;
}

// ---- trigger: new tab opened and loaded enough to classify (§5.1) ---------------------
browser.tabs.onCreated.addListener(tab => {
  if (tab.incognito || tab.pinned) {
    return;
  }
  pendingNewTabs.add(tab.id);
});

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Correction detection: the actor put this tab in a group and it left that group.
  if ("groupId" in change) {
    const placed = autoAdded.get(tabId);
    if (placed !== undefined && change.groupId !== placed) {
      autoAdded.delete(tabId);
      if (change.groupId === -1) {
        state.exclusions[tabId] = placed;
        persist();
        logAction(`Tab left its auto group; will not re-add it there`);
      }
    }
  }
  if (!pendingNewTabs.has(tabId)) {
    return;
  }
  if (change.status === "complete" && isHttp(tab.url) && tab.title) {
    pendingNewTabs.delete(tabId);
    schedule(tabId);
  }
});

browser.tabs.onRemoved.addListener(tabId => {
  pendingNewTabs.delete(tabId);
  autoAdded.delete(tabId);
  if (timers.has(tabId)) {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);   // §5.2: closed before the timer fired → nothing happens
  }
  if (tabId in state.exclusions) {
    delete state.exclusions[tabId];
    persist();
  }
});

browser.tabGroups.onRemoved.addListener(group => {
  const before = state.lastCreatedGroupIds.length;
  state.lastCreatedGroupIds = state.lastCreatedGroupIds.filter(id => id !== group.id);
  delete state.groupOrigin[group.id];
  if (before !== state.lastCreatedGroupIds.length) {
    persist();
  }
});

function schedule(tabId) {
  if (!state.settings.enabled) {
    return;
  }
  if (timers.has(tabId)) {
    clearTimeout(timers.get(tabId));
  }
  timers.set(tabId, setTimeout(() => {
    timers.delete(tabId);
    enqueue(tabId);
  }, state.settings.joinDelayMs));
}

function enqueue(tabId) {
  // Strict FIFO, one tab at a time; classification happens at dequeue.
  queue = queue.then(() => process(tabId)).catch(e => console.warn("[auto-grouping] process failed", e));
}

// ---- the actor (§5.1 decision order, re-validated at fire time) ---------------------
async function process(tabId) {
  if (!state.settings.enabled) {
    return;
  }
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {
    return; // closed
  }
  if (!isLooseCandidate(tab)) {
    return; // pinned, already grouped by the user, or not a web page
  }
  const [groups, allTabs] = await Promise.all([
    browser.tabGroups.query({ windowId: tab.windowId }),
    browser.tabs.query({ windowId: tab.windowId }),
  ]);
  const { threshold, minClusterSize } = state.settings;

  // JOIN: one tab is enough to join an existing group (§5.3).
  const fit = await Classifier.bestGroup(tab, groups, allTabs, state.exclusions[tab.id], threshold);
  if (fit) {
    const fresh = await browser.tabs.get(tabId).catch(() => null);
    if (!isLooseCandidate(fresh)) {
      return;
    }
    await browser.tabs.group({ tabIds: [tab.id], groupId: fit.group.id });
    await moveToEndOfGroup(tab.id, fit.group.id);
    await revealGroup(fit.group.id);
    autoAdded.set(tab.id, fit.group.id);
    logAction(`Joined "${fit.group.title || "untitled group"}" (score ${fit.score.toFixed(2)})`);
    return;
  }

  // CREATE: only the trigger tab's own cluster among loose tabs is considered (§5.4).
  const loose = allTabs.filter(t => t.id !== tab.id && isLooseCandidate(t));
  const members = await Classifier.clusterAround(tab, loose, threshold);
  if (members.length + 1 < minClusterSize) {
    return; // leave it loose
  }
  const { title, color } = await Classifier.label([tab, ...members], groups.map(g => g.title || ""));

  // Name collision with an existing group → treat as JOIN of the trigger tab instead.
  const sameName = groups.find(g => (g.title || "").toLowerCase() === title.toLowerCase());
  if (sameName && state.exclusions[tab.id] !== sameName.id) {
    await browser.tabs.group({ tabIds: [tab.id], groupId: sameName.id });
    await moveToEndOfGroup(tab.id, sameName.id);
    await revealGroup(sameName.id);
    autoAdded.set(tab.id, sameName.id);
    logAction(`Joined "${sameName.title}" (same name as the proposed group)`);
    return;
  }

  // Form in place at the trigger tab: members slide in before it, trigger ends up last.
  const ordered = members.slice().sort((a, b) => a.index - b.index);
  for (const m of ordered) {
    const anchor = await browser.tabs.get(tab.id).catch(() => null);
    if (!isLooseCandidate(anchor)) {
      return;
    }
    const target = m.index < anchor.index ? anchor.index - 1 : anchor.index;
    await browser.tabs.move(m.id, { index: target });
  }
  const groupId = await browser.tabs.group({ tabIds: [...ordered.map(m => m.id), tab.id] });
  await browser.tabGroups.update(groupId, { title, color, collapsed: false });
  state.lastCreatedGroupIds.push(groupId);
  state.groupOrigin[groupId] = "sw";
  for (const t of [tab, ...ordered]) {
    autoAdded.set(t.id, groupId);
  }
  await persist();
  logAction(`Created "${title}" with ${ordered.length + 1} tabs`);
}

// Expand the group a tab was just added to, so the user can see where it went.
async function revealGroup(groupId) {
  try {
    await browser.tabGroups.update(groupId, { collapsed: false });
  } catch (e) {
    console.warn("[auto-grouping] could not expand group", groupId, e);
  }
}

async function moveToEndOfGroup(tabId, groupId) {
  const tabs = (await browser.tabs.query({ groupId })).sort((a, b) => a.index - b.index);
  const last = tabs[tabs.length - 1];
  if (last && last.id !== tabId) {
    await browser.tabs.move(tabId, { index: last.index });
  }
}

// ---- menu actions (§8.6, §8.7) -----------------------------------------------------------
async function setEnabled(enabled) {
  state.settings.enabled = !!enabled;
  if (!enabled) {
    for (const t of timers.values()) {
      clearTimeout(t); // stop scheduled work; keep every group as-is
    }
    timers.clear();
    pendingNewTabs.clear();
  }
  // Turning back on does not regroup existing loose tabs; only tabs opened from now on.
  await persist();
  logAction(enabled ? "Auto grouping on" : "Auto grouping off");
}

async function lastGroup() {
  while (state.lastCreatedGroupIds.length) {
    const id = state.lastCreatedGroupIds[state.lastCreatedGroupIds.length - 1];
    try {
      return await browser.tabGroups.get(id);
    } catch (e) {
      state.lastCreatedGroupIds.pop(); // gone
    }
  }
  return null;
}

async function undoLastGroup() {
  const group = await lastGroup();
  if (!group) {
    return null;
  }
  const tabs = await browser.tabs.query({ groupId: group.id });
  for (const t of tabs) {
    state.exclusions[t.id] = group.id; // counts as a correction (§7)
    autoAdded.delete(t.id);
  }
  await browser.tabs.ungroup(tabs.map(t => t.id)); // ungroups in place
  state.lastCreatedGroupIds = state.lastCreatedGroupIds.filter(id => id !== group.id);
  delete state.groupOrigin[group.id];
  await persist();
  logAction(`Undid group "${group.title || "untitled"}" (${tabs.length} tabs)`);
  return group.title || "";
}

async function snapshot() {
  const group = await lastGroup();
  return {
    settings: state.settings,
    undoTitle: group ? group.title || "Untitled group" : null,
    undoCount: state.lastCreatedGroupIds.length,
    model: Classifier.status(),
    log: state.log,
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case "getState":
      return snapshot();
    case "setEnabled":
      return setEnabled(msg.enabled).then(snapshot);
    case "undo":
      return undoLastGroup().then(snapshot);
    case "warmModel":
      // Permission itself is requested by the popup (needs a user gesture).
      return Classifier.ensureEngine().then(snapshot);
    case "debugSim":
      return Classifier.debugSim(msg.tabs || []);
    case "setSettings":
      state.settings = { ...state.settings, ...(msg.settings || {}) };
      return persist().then(snapshot);
    default:
      return undefined;
  }
});

load().then(() => {
  logAction("Ready");
  Classifier.ensureEngine(); // warms the model if the permission was granted earlier
});
