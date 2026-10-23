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
  dedupe: true,         // jump to an already-open tab instead of opening a copy
};
const FRESH_MS = 10000;        // a tab counts as fresh for this long after it was created
const STARTUP_GRACE_MS = 15000; // ignore tabs created while a session is being restored

const FLASH_PREFIX = "\u2726 "; // "✦ " in front of the group name while a tab lands

const state = {
  settings: { ...DEFAULT_SETTINGS },
  lastCreatedGroupIds: [],   // §2, target of "Undo last group"
  groupOrigin: {},           // groupId -> "sw" (user-made groups are simply absent)
  exclusions: {},            // tabId -> groupId: never auto-add this tab to that group again
  log: [],                   // last few actions, for the popup
  recentMoves: [],           // newest first: { tabId, title, groupId, groupTitle, at } for the menu's "Show me"
  unseenMoves: 0,            // toolbar badge count, cleared when the menu opens
};

const pendingNewTabs = new Set();   // created this session, waiting for first real load
const timers = new Map();           // tabId -> timeout id
const autoAdded = new Map();        // tabId -> groupId the actor put it in (correction detection)
const freshTabs = new Map();        // tabId -> { at, active }: tabs that have not navigated yet
const exemptTabs = new Set();       // tabs the user asked to reopen as a copy; never deduped
const startedAt = Date.now();
const pendingVisits = new Map();    // tabId -> groupId: moved tabs the user has not clicked into yet
const flashedTitles = new Map();    // groupId -> original title while the sparkle prefix is shown
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
    for (const g of await browser.tabGroups.query({})) {
      if ((g.title || "").startsWith(FLASH_PREFIX)) {
        await browser.tabGroups.update(g.id, { title: stripFlash(g.title) });
      }
    }
  } catch (e) {
    console.warn("[auto-grouping] prune failed", e);
  }
  await persist();
}

function stripFlash(title) {
  return (title || "").startsWith(FLASH_PREFIX) ? title.slice(FLASH_PREFIX.length) : title || "";
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
  freshTabs.set(tab.id, { at: Date.now(), active: !!tab.active });
});

// ---- duplicates: a fresh tab navigating to a URL that is already open -------------------
// Jump to the existing tab (same window and container) and drop the new one,
// so no copy ever appears. Only a tab's first navigation counts, and only
// within FRESH_MS of its creation, so restored sessions and long-lived blank
// tabs are left alone. Background opens (middle-click) do not steal focus:
// the existing tab is highlighted instead.
function sameUrl(a, b) {
  const strip = u => (u || "").replace(/\/$/, "");
  return strip(a) === strip(b);
}

browser.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) {
    return;
  }
  const fresh = freshTabs.get(details.tabId);
  if (!fresh) {
    return;
  }
  freshTabs.delete(details.tabId);
  if (!state.settings.dedupe || exemptTabs.has(details.tabId)) {
    return;
  }
  if (Date.now() - fresh.at > FRESH_MS || Date.now() - startedAt < STARTUP_GRACE_MS) {
    return;
  }
  if (!isHttp(details.url)) {
    return;
  }
  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch (e) {
    return;
  }
  if (tab.pinned || tab.incognito) {
    return;
  }
  const windowTabs = await browser.tabs.query({ windowId: tab.windowId });
  const existing = windowTabs.find(
    t => t.id !== tab.id && t.cookieStoreId === tab.cookieStoreId && sameUrl(t.url, details.url)
  );
  if (!existing) {
    return;
  }
  const takeFocus = fresh.active || tab.active;
  state.recentMoves.unshift({
    kind: "dedupe", tabId: existing.id, title: existing.title, url: details.url,
    groupId: existing.groupId, groupTitle: "", at: Date.now(),
    reopen: { url: details.url, index: tab.index, windowId: tab.windowId, cookieStoreId: tab.cookieStoreId, active: takeFocus },
  });
  state.recentMoves = state.recentMoves.slice(0, 10);
  state.unseenMoves += 1;
  setBadge();
  if (existing.groupId !== -1) {
    await revealGroup(existing.groupId);
  }
  if (takeFocus) {
    await browser.tabs.update(existing.id, { active: true }).catch(() => {});
  } else {
    pendingVisits.set(existing.id, existing.groupId);
    await browser.tabs.update(existing.id, { highlighted: true, active: false }).catch(() => {});
  }
  if (existing.groupId !== -1) {
    await flashGroupTitle(existing.groupId);
    if (!takeFocus) {
      pendingVisits.set(existing.id, existing.groupId);
    }
  }
  await browser.tabs.remove(tab.id).catch(() => {});
  logAction(`Jumped to open tab "${existing.title}" instead of opening a copy`);
});

async function reopenLastCopy() {
  const m = state.recentMoves.find(x => x.kind === "dedupe" && x.reopen);
  if (!m) {
    return;
  }
  const { url, index, windowId, cookieStoreId, active } = m.reopen;
  let created;
  try {
    created = await browser.tabs.create({ url, index, windowId, cookieStoreId, active: true });
  } catch (e) {
    created = await browser.tabs.create({ url, active: true });
  }
  exemptTabs.add(created.id);
  m.reopen = null;
  logAction(`Reopened a copy of "${m.title}"`);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Correction detection: the actor put this tab in a group and it left that group.
  if ("groupId" in change) {
    if (pendingVisits.has(tabId) && change.groupId !== pendingVisits.get(tabId)) {
      settleVisit(tabId);
    }
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
  freshTabs.delete(tabId);
  exemptTabs.delete(tabId);
  autoAdded.delete(tabId);
  settleVisit(tabId, { clearHighlight: false });
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
  let [groups, allTabs] = await Promise.all([
    browser.tabGroups.query({ windowId: tab.windowId }),
    browser.tabs.query({ windowId: tab.windowId }),
  ]);
  groups = groups.map(g => ({ ...g, title: stripFlash(g.title) }));
  const { threshold, minClusterSize } = state.settings;

  // JOIN: one tab is enough to join an existing group (§5.3).
  const fit = await Classifier.bestGroup(tab, groups, allTabs, state.exclusions[tab.id]);
  if (fit) {
    const fresh = await browser.tabs.get(tabId).catch(() => null);
    if (!isLooseCandidate(fresh)) {
      return;
    }
    await browser.tabs.group({ tabIds: [tab.id], groupId: fit.group.id });
    await moveToEndOfGroup(tab.id, fit.group.id);
    await revealGroup(fit.group.id);
    autoAdded.set(tab.id, fit.group.id);
    const d = fit.detail;
    logAction(`Joined "${fit.group.title || "untitled group"}" (p=${fit.score.toFixed(2)}; title ${d.titleCos.toFixed(2)}, domain ${d.domainFrac.toFixed(2)}, name ${d.groupCos.toFixed(2)})`);
    announceMove(tab, fit.group);
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
    announceMove(tab, sameName);
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

// Make the landing visible: highlight the moved tab (without changing the
// active tab), prefix the group name with a sparkle, record it for the menu,
// and badge the toolbar button. Highlight and prefix stay until the user
// clicks into the moved tab (or closes it, or moves it out of the group).
async function announceMove(tab, group) {
  state.recentMoves.unshift({ tabId: tab.id, title: tab.title, groupId: group.id, groupTitle: group.title || "", at: Date.now() });
  state.recentMoves = state.recentMoves.slice(0, 10);
  state.unseenMoves += 1;
  setBadge();
  let fresh;
  try {
    fresh = await browser.tabs.get(tab.id);
  } catch (e) {
    return; // tab gone
  }
  pendingVisits.set(tab.id, group.id);
  if (!fresh.active) {
    await browser.tabs.update(tab.id, { highlighted: true, active: false }).catch(() => {});
  }
  // A tab that is already in the foreground still gets the sparkle; it clears
  // the next time the user clicks into that tab (after switching away).
  await flashGroupTitle(group.id);
}

async function flashGroupTitle(groupId) {
  if (flashedTitles.has(groupId)) {
    return;
  }
  try {
    const live = await browser.tabGroups.get(groupId);
    const original = stripFlash(live.title);
    flashedTitles.set(groupId, original);
    await browser.tabGroups.update(groupId, { title: FLASH_PREFIX + original });
  } catch (e) {
    flashedTitles.delete(groupId);
  }
}

// Called when a moved tab is visited, closed, or leaves its group.
async function settleVisit(tabId, { clearHighlight = true } = {}) {
  const groupId = pendingVisits.get(tabId);
  if (groupId === undefined) {
    return;
  }
  pendingVisits.delete(tabId);
  if (clearHighlight) {
    await browser.tabs.update(tabId, { highlighted: false }).catch(() => {});
  }
  const stillPending = [...pendingVisits.values()].includes(groupId);
  if (!stillPending && flashedTitles.has(groupId)) {
    const original = flashedTitles.get(groupId);
    flashedTitles.delete(groupId);
    try {
      const now = await browser.tabGroups.get(groupId);
      if (now.title === FLASH_PREFIX + original) {
        await browser.tabGroups.update(groupId, { title: original });
      }
    } catch (e) {
      // group gone
    }
  }
}

browser.tabs.onActivated.addListener(info => {
  // Activating the tab already selects it alone, so no highlight to clear.
  settleVisit(info.tabId, { clearHighlight: false });
});

function setBadge() {
  const text = state.unseenMoves ? String(state.unseenMoves) : "";
  browser.browserAction.setBadgeText({ text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ color: "#0062fa" }).catch(() => {});
}

// Newest move whose tab still exists; drops entries for closed tabs.
async function latestMove() {
  while (state.recentMoves.length) {
    const m = state.recentMoves[0];
    try {
      const tab = await browser.tabs.get(m.tabId);
      return { m, tab };
    } catch (e) {
      state.recentMoves.shift();
    }
  }
  return null;
}

async function showLastMoved() {
  const latest = await latestMove();
  if (!latest) {
    return;
  }
  const { tab } = latest;
  if (tab.groupId !== -1) {
    await browser.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
  }
  await browser.tabs.update(tab.id, { active: true }).catch(() => {});
  await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
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
  logAction(`Undid group "${stripFlash(group.title) || "untitled"}" (${tabs.length} tabs)`);
  return stripFlash(group.title);
}

async function snapshot() {
  const group = await lastGroup();
  return {
    settings: state.settings,
    undoTitle: group ? stripFlash(group.title) || "Untitled group" : null,
    undoCount: state.lastCreatedGroupIds.length,
    model: Classifier.status(),
    log: state.log,
    lastMoved: await lastMovedInfo(),
  };
}

async function lastMovedInfo() {
  const latest = await latestMove();
  if (!latest) {
    return null;
  }
  const { m, tab } = latest;
  const group = tab.groupId !== -1 ? await browser.tabGroups.get(tab.groupId).catch(() => null) : null;
  return {
    kind: m.kind || "join", title: tab.title, groupTitle: group ? stripFlash(group.title) : null, at: m.at,
    stillThere: m.kind === "dedupe" ? true : !!group && group.id === m.groupId,
    canReopen: m.kind === "dedupe" && !!m.reopen,
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case "getState":
      if (msg.fromPopup && state.unseenMoves) {
        state.unseenMoves = 0;
        setBadge();
      }
      return snapshot();
    case "showLastMoved":
      return showLastMoved().then(snapshot);
    case "reopenLastCopy":
      return reopenLastCopy().then(snapshot);
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
