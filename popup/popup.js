/* global browser */

const $ = id => document.getElementById(id);

function render(s) {
  $("sw-autogroup-toggle").checked = !!s.settings.enabled;
  $("sw-dedupe-toggle").checked = !!s.settings.dedupe;
  const undo = $("sw-autogroup-undo");
  undo.disabled = !s.undoTitle;
  $("sw-autogroup-undo-desc").textContent = s.undoTitle ? s.undoTitle : "Nothing to undo";

  const lm = s.lastMoved;
  $("last-moved-row").hidden = !lm;
  if (lm) {
    const ago = Math.max(0, Math.round((Date.now() - lm.at) / 1000));
    const when = ago < 60 ? ago + "s" : Math.round(ago / 60) + " min";
    if (lm.kind === "dedupe") {
      $("last-moved-desc").textContent = `Jumped to "${lm.title}" instead of opening a copy, ${when} ago`;
    } else {
      const where = lm.stillThere ? `into "${lm.groupTitle}"` : "(since moved by you)";
      $("last-moved-desc").textContent = `"${lm.title}" ${where}, ${when} ago`;
    }
    $("show-last-moved").hidden = !lm.stillThere;
    $("reopen-copy").hidden = !lm.canReopen;
  }

  $("model-detail").textContent = s.model.detail;
  $("model-enable").hidden = s.model.ready || /Downloading|Loading/.test(s.model.detail);

  $("adv-delay").value = s.settings.joinDelayMs;
  $("adv-min").value = s.settings.minClusterSize;
  $("adv-threshold").value = s.settings.threshold;
  $("log").textContent = (s.log || []).join("\n");
}

async function refresh() {
  render(await browser.runtime.sendMessage({ type: "getState", fromPopup: true }));
}

$("show-last-moved").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "showLastMoved" });
  window.close();
});

$("reopen-copy").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "reopenLastCopy" });
  window.close();
});

$("sw-dedupe-toggle").addEventListener("change", async e => {
  render(await browser.runtime.sendMessage({ type: "setSettings", settings: { dedupe: e.target.checked } }));
});

$("sw-autogroup-toggle").addEventListener("change", async e => {
  render(await browser.runtime.sendMessage({ type: "setEnabled", enabled: e.target.checked }));
});

$("sw-autogroup-undo").addEventListener("click", async () => {
  render(await browser.runtime.sendMessage({ type: "undo" }));
  window.close(); // the panel closes on undo, like the Nightly prototype
});

$("model-enable").addEventListener("click", async () => {
  // Optional permission: must be requested from a user gesture in an extension page.
  let granted = false;
  try {
    granted = await browser.permissions.request({ permissions: ["trialML"] });
  } catch (e) {
    $("model-detail").textContent = `Permission request failed: ${e.message}`;
    return;
  }
  if (!granted) {
    $("model-detail").textContent = "Permission not granted; using heuristic grouping.";
    return;
  }
  $("model-detail").textContent = "Loading model…";
  $("model-enable").hidden = true;
  browser.runtime.sendMessage({ type: "warmModel" }).then(render);
});

for (const [id, key, parse] of [
  ["adv-delay", "joinDelayMs", v => Math.max(0, parseInt(v, 10) || 0)],
  ["adv-min", "minClusterSize", v => Math.min(6, Math.max(2, parseInt(v, 10) || 3))],
  ["adv-threshold", "threshold", v => Math.min(0.95, Math.max(0.1, parseFloat(v) || 0.45))],
]) {
  $(id).addEventListener("change", async e => {
    render(await browser.runtime.sendMessage({ type: "setSettings", settings: { [key]: parse(e.target.value) } }));
  });
}

refresh();
const poll = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(poll));
