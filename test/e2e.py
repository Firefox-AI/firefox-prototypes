#!/usr/bin/env python3
"""End-to-end test for the Smart Window auto grouping extension.

Launches Firefox Nightly with a throwaway profile, installs the extension
temporarily, and drives the demo scenarios through Marionette (chrome scope):
CREATE, JOIN, cancel-on-close, the popup menu (toggle + undo), then the
on-device model path.

Run from a Firefox checkout so marionette_driver is importable:
    cd <worktree> && ./mach python <ext>/test/e2e.py [--firefox <binary>] [--keep]
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_ID = "smart-auto-grouping@prototype.mozilla.org"
NIGHTLY = "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"

TRAVEL = [
    "https://en.wikivoyage.org/wiki/Lisbon",
    "https://en.wikivoyage.org/wiki/Porto",
    "https://en.wikivoyage.org/wiki/Algarve",
]
TRAVEL_MORE = [
    "https://en.wikivoyage.org/wiki/Madeira",
    "https://en.wikivoyage.org/wiki/Azores",
    "https://en.wikivoyage.org/wiki/Coimbra",
    "https://en.wikivoyage.org/wiki/Sintra",
]
RECIPES = [
    "https://en.wikibooks.org/wiki/Cookbook:Pancakes",
    "https://en.wikibooks.org/wiki/Cookbook:Banana_Bread",
    "https://en.wikibooks.org/wiki/Cookbook:Chocolate_Chip_Cookies",
]
# Cross-domain food pages: the heuristic sees no shared site/keywords, the model should.
MODEL_SET = [
    "https://en.wikipedia.org/wiki/Pancake",
    "https://en.wikibooks.org/wiki/Cookbook:Waffles",
    "https://simple.wikipedia.org/wiki/Crêpe",
]

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def launch(binary, port):
    profile = tempfile.mkdtemp(prefix="sag-e2e-")
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(
            f'user_pref("marionette.port", {port});\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("browser.startup.homepage", "about:blank");\n'
            'user_pref("browser.startup.page", 0);\n'
            'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\n'
            'user_pref("browser.aboutwelcome.enabled", false);\n'
            'user_pref("browser.tabs.groups.enabled", true);\n'
            'user_pref("browser.tabs.groups.smart.userEnabled", false);\n'
            'user_pref("extensions.ml.enabled", true);\n'
            'user_pref("browser.ml.enable", true);\n'
            'user_pref("browser.sessionstore.resume_from_crash", false);\n'
            # Marionette's automation prefs point Remote Settings at a dummy data: URL,
            # which starves the ML engine of its runtime. Use the real server.
            'user_pref("services.settings.server", "https://firefox.settings.services.mozilla.com/v1");\n'
        )
    env = dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1")
    proc = subprocess.Popen(
        [binary, "-no-remote", "-profile", profile, "-marionette", "-remote-allow-system-access", "-foreground"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )
    return proc, profile


def chrome(client, script, *args):
    return client.execute_script(script, script_args=list(args), sandbox="system")


def chrome_async(client, script, *args, timeout=30):
    client.timeout.script = timeout
    return client.execute_async_script(script, script_args=list(args), sandbox="system")


def add_tab(client, url):
    return chrome(client, """
      const [url] = arguments;
      const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      tab.setAttribute("data-e2e", url);
      return url;
    """, url)


def tab_info(client):
    """[{url, title, index, pinned, group}] in strip order."""
    return chrome(client, """
      return Array.from(gBrowser.tabs).map((t, i) => ({
        url: t.linkedBrowser.currentURI.spec,
        e2e: t.getAttribute("data-e2e"),
        title: t.label,
        index: i,
        pinned: t.pinned,
        group: t.group ? t.group.label.replace(/^\u2726 /, "") : null,
        groupRaw: t.group ? t.group.label : null,
        groupId: t.group ? t.group.id : null,
        multiselected: t.multiselected,
        selected: t.selected,
      }));
    """)


def groups(client):
    return chrome(client, """
      return gBrowser.tabGroups.map(g => ({ id: g.id, label: g.label.replace(/^\u2726 /, ""), rawLabel: g.label, tabs: g.tabs.map(t => t.getAttribute("data-e2e") || t.linkedBrowser.currentURI.spec) }));
    """)


def find(client, url):
    for t in tab_info(client):
        if t["e2e"] == url:
            return t
    return None


def wait_for(pred, timeout, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = pred()
        if last:
            return last
        time.sleep(step)
    return last


def wait_loaded(client, urls, timeout=40):
    def done():
        infos = {t["e2e"]: t for t in tab_info(client)}
        return all(u in infos and infos[u]["title"] and not infos[u]["title"].startswith("http") and infos[u]["title"] != "New Tab" for u in urls)
    return wait_for(done, timeout)


def close_tab(client, url):
    chrome(client, """
      const [url] = arguments;
      const tab = gBrowser.tabs.find(t => t.getAttribute("data-e2e") === url);
      if (tab) gBrowser.removeTab(tab);
    """, url)


def make_user_group(client, urls, label):
    return chrome(client, """
      const [urls, label] = arguments;
      const tabs = urls.map(u => gBrowser.tabs.find(t => t.getAttribute("data-e2e") === u));
      const g = gBrowser.addTabGroup(tabs, { label, color: "blue" });
      return g.id;
    """, urls, label)


def activate_tab(client, url):
    chrome(client, """
      const [url] = arguments;
      const tab = gBrowser.tabs.find(t => t.getAttribute("data-e2e") === url);
      if (tab) gBrowser.selectedTab = tab;
    """, url)


def set_collapsed(client, label, collapsed):
    chrome(client, """
      const [label, collapsed] = arguments;
      const g = gBrowser.tabGroups.find(g => g.label.replace(/^\u2726 /, "") === label);
      if (g) g.collapsed = collapsed;
    """, label, collapsed)


def is_collapsed(client, label):
    return chrome(client, """
      const [label] = arguments;
      const g = gBrowser.tabGroups.find(g => g.label.replace(/^\u2726 /, "") === label);
      return g ? g.collapsed : null;
    """, label)


WIDGET_ID = "smart-auto-grouping_prototype_mozilla_org-browser-action"


def pin_button(client):
    """Move the toolbar button out of the extensions panel into the nav bar, like a user pinning it."""
    chrome(client, """
      const [id] = arguments;
      const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
      CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
    """, WIDGET_ID)


def badge_text(client):
    return chrome(client, """
      const [id] = arguments;
      const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
      const node = CustomizableUI.getWidget(id)?.forWindow(window)?.node;
      if (!node) return null;
      const btn = node.querySelector(".unified-extensions-item-action-button") || node;
      return btn.getAttribute("badge") || "";
    """, WIDGET_ID)


def popup_url(client):
    host = chrome(client, """
      const [id] = arguments;
      return WebExtensionPolicy.getByID(id).mozExtensionHostname;
    """, EXT_ID)
    return f"moz-extension://{host}/popup/popup.html"


def open_popup_tab(client):
    """Open the popup page as a normal tab and return its tab handle."""
    url = popup_url(client)
    chrome(client, """
      const [url] = arguments;
      const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      tab.setAttribute("data-e2e", "popup");
      gBrowser.selectedTab = tab;
    """, url)
    time.sleep(1.5)
    client.set_context("content")
    for handle in client.window_handles:
        client.switch_to_window(handle)
        if client.get_url().startswith("moz-extension://"):
            client.set_context("chrome")
            return handle
    client.set_context("chrome")
    raise RuntimeError("popup tab not found")


def popup_eval(client, handle, script):
    client.set_context("content")
    client.switch_to_window(handle)
    try:
        return client.execute_script(script)
    finally:
        client.set_context("chrome")


def popup_click(client, handle, selector):
    client.set_context("content")
    client.switch_to_window(handle)
    try:
        client.find_element("css selector", selector).click()
    finally:
        client.set_context("chrome")


def popup_state(client, handle):
    time.sleep(1.2)  # popup polls the background every second
    return popup_eval(client, handle, """
      return {
        enabled: document.getElementById("sw-autogroup-toggle").checked,
        undoDisabled: document.getElementById("sw-autogroup-undo").disabled,
        undoDesc: document.getElementById("sw-autogroup-undo-desc").textContent,
        model: document.getElementById("model-detail").textContent,
        log: document.getElementById("log").textContent,
      };
    """)


def debug_sim(client, handle, tabs):
    """Call the background's debugSim through the popup page's own realm (sandbox=None)."""
    client.set_context("content")
    client.switch_to_window(handle)
    client.timeout.script = 120
    try:
        raw = client.execute_async_script(
            "const [tabs, resolve] = arguments;"
            "browser.runtime.sendMessage({ type: 'debugSim', tabs }).then(r => resolve(JSON.stringify(r)), e => resolve(JSON.stringify({ error: String(e) })));",
            script_args=[tabs], sandbox=None)
    finally:
        client.set_context("chrome")
    return json.loads(raw)


TRAVEL_TITLES = [
    {"title": "Lisbon – Travel guide at Wikivoyage", "url": "https://en.wikivoyage.org/wiki/Lisbon"},
    {"title": "Hotel Avenida Palace, Lisbon – Booking.com", "url": "https://www.booking.com/hotel/pt/avenida-palace.html"},
    {"title": "Cheap Flights to Lisbon from $312 | Kayak", "url": "https://www.kayak.com/flights/SFO-LIS"},
    {"title": "Inbox (3) - Gmail", "url": "https://mail.google.com/mail/u/0/"},
]


def grant_trial_ml(client):
    return chrome_async(client, """
      const [id, resolve] = arguments;
      (async () => {
        const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
        const perms = { permissions: ["trialML"], origins: [] };
        // Pass the live extension so it learns about the grant without a reload.
        const ext = WebExtensionPolicy.getByID(id).extension;
        try { await ExtensionPermissions.add(id, { ...perms, data_collection: [] }, ext); }
        catch (e) { await ExtensionPermissions.add(id, perms, ext); }
        const got = await ExtensionPermissions.get(id);
        resolve(JSON.stringify(got));
      })().catch(e => resolve("ERR " + e));
    """, EXT_ID, timeout=20)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--firefox", default=NIGHTLY)
    ap.add_argument("--keep", action="store_true", help="leave Firefox running at the end")
    ap.add_argument("--skip-model", action="store_true")
    args = ap.parse_args()

    port = free_port()
    proc, profile = launch(args.firefox, port)
    client = Marionette(host="127.0.0.1", port=port, startup_timeout=90)
    try:
        client.start_session()
        client.set_context("chrome")
        Addons(client).install(EXT_DIR, temp=True)
        time.sleep(2)
        ok = chrome(client, "const [id] = arguments; return !!WebExtensionPolicy.getByID(id);", EXT_ID)
        record("smoke: extension installed", bool(ok))
        pin_button(client)

        # ---- CREATE -------------------------------------------------------------------
        add_tab(client, RECIPES[0]); add_tab(client, RECIPES[1])
        wait_loaded(client, RECIPES[:2])
        time.sleep(6)
        two_loose = all(find(client, u)["group"] is None for u in RECIPES[:2])
        record("create: 2 related tabs stay loose", two_loose, json.dumps(groups(client)))
        add_tab(client, RECIPES[2])
        wait_loaded(client, [RECIPES[2]])
        created = wait_for(lambda: next((g for g in groups(client) if set(RECIPES) <= set(g["tabs"])), None), 25)
        trigger_last = bool(created) and created["tabs"][-1] == RECIPES[2] and len(created["tabs"]) == 3
        record("create: 3rd tab forms a group, trigger last, labelled", bool(created) and trigger_last and bool(created["label"]),
               json.dumps(created))
        created_label = created["label"] if created else None

        # ---- JOIN (user-made group) ---------------------------------------------------------
        for u in TRAVEL:
            add_tab(client, u)
        make_user_group(client, TRAVEL, "Travel")
        wait_loaded(client, TRAVEL)
        time.sleep(4)
        travel = next((g for g in groups(client) if g["label"] == "Travel"), None)
        record("join: pre-made Travel group intact after loads", bool(travel) and len(travel["tabs"]) == 3, json.dumps(travel))
        set_collapsed(client, "Travel", True)
        t0 = time.time()
        add_tab(client, TRAVEL_MORE[0])
        wait_loaded(client, [TRAVEL_MORE[0]])
        joined = wait_for(lambda: (lambda t: t and t["group"] == "Travel")(find(client, TRAVEL_MORE[0])), 25)
        travel = next((g for g in groups(client) if g["label"] == "Travel"), None)
        record("join: new travel tab joins Travel at the end", bool(joined) and travel and travel["tabs"][-1] == TRAVEL_MORE[0],
               f"{time.time() - t0:.1f}s after open; group={json.dumps(travel)}")
        time.sleep(0.5)
        record("join: collapsed Travel group is expanded after the join", is_collapsed(client, "Travel") is False,
               f"collapsed={is_collapsed(client, 'Travel')}")
        moved = find(client, TRAVEL_MORE[0])
        travel_raw = next((g["rawLabel"] for g in groups(client) if g["label"] == "Travel"), None)
        badge = badge_text(client)
        record("feedback: moved tab highlighted, group title flashed, badge set",
               bool(moved) and moved["multiselected"] and not moved["selected"] and travel_raw == "\u2726 Travel" and badge == "1",
               json.dumps({"multiselected": moved and moved["multiselected"], "selected": moved and moved["selected"], "label": travel_raw, "badge": badge}))
        time.sleep(8)
        moved = find(client, TRAVEL_MORE[0])
        travel_raw = next((g["rawLabel"] for g in groups(client) if g["label"] == "Travel"), None)
        record("feedback: still highlighted and flashed 8s later (no timeout)",
               bool(moved) and moved["multiselected"] and travel_raw == "\u2726 Travel",
               json.dumps({"multiselected": moved and moved["multiselected"], "label": travel_raw}))
        activate_tab(client, TRAVEL_MORE[0])
        time.sleep(1)
        moved = find(client, TRAVEL_MORE[0])
        travel_raw = next((g["rawLabel"] for g in groups(client) if g["label"] == "Travel"), None)
        record("feedback: clicking into the moved tab clears highlight and sparkle",
               bool(moved) and moved["selected"] and not moved["multiselected"] and travel_raw == "Travel",
               json.dumps({"selected": moved and moved["selected"], "multiselected": moved and moved["multiselected"], "label": travel_raw}))
        activate_tab(client, RECIPES[0])  # leave the moved tab again before the next steps
        # Foreground join: the tab is selected while it joins; sparkle must still show.
        chrome(client, """
          const [url] = arguments;
          const t = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: false });
          t.setAttribute("data-e2e", url);
        """, TRAVEL_MORE[1])
        wait_loaded(client, [TRAVEL_MORE[1]])
        fg = wait_for(lambda: (lambda t: t and t["group"] == "Travel")(find(client, TRAVEL_MORE[1])), 25)
        time.sleep(1)
        travel_raw = next((g["rawLabel"] for g in groups(client) if g["label"] == "Travel"), None)
        record("feedback: foreground tab that joins still shows the sparkle",
               bool(fg) and find(client, TRAVEL_MORE[1])["selected"] and travel_raw == "\u2726 Travel",
               json.dumps({"selected": find(client, TRAVEL_MORE[1])["selected"], "label": travel_raw}))
        activate_tab(client, RECIPES[0])
        time.sleep(0.5)
        activate_tab(client, TRAVEL_MORE[1])
        time.sleep(1)
        travel_raw = next((g["rawLabel"] for g in groups(client) if g["label"] == "Travel"), None)
        record("feedback: switching away and back clears it", travel_raw == "Travel", json.dumps({"label": travel_raw}))
        close_tab(client, TRAVEL_MORE[1])
        activate_tab(client, RECIPES[0])
        time.sleep(1)

        # ---- cancel on close ---------------------------------------------------------------
        add_tab(client, TRAVEL_MORE[1])
        wait_loaded(client, [TRAVEL_MORE[1]], timeout=20)
        time.sleep(0.5)
        close_tab(client, TRAVEL_MORE[1])
        time.sleep(5)
        travel2 = next((g for g in groups(client) if g["label"] == "Travel"), None)
        record("join: closing before the delay does nothing", travel2 and len(travel2["tabs"]) == 4, json.dumps(travel2))

        # ---- MENU ---------------------------------------------------------------------------------
        handle = open_popup_tab(client)
        st = popup_state(client, handle)
        record("menu: toggle on, undo enabled with group name",
               st["enabled"] and not st["undoDisabled"] and st["undoDesc"] == created_label, json.dumps(st))
        lm = popup_eval(client, handle, """
          const row = document.getElementById("last-moved-row");
          return { hidden: row.hidden, text: document.getElementById("last-moved-desc").textContent,
                   showHidden: document.getElementById("show-last-moved").hidden };
        """)
        badge_after = badge_text(client)
        record("menu: Last moved row names the tab and group; badge cleared on open",
               (not lm["hidden"]) and "Travel" in lm["text"] and "Madeira" in lm["text"] and not lm["showHidden"] and badge_after == "",
               json.dumps({"row": lm, "badge": badge_after}))
        popup_click(client, handle, "#show-last-moved")
        time.sleep(1)
        sel = find(client, TRAVEL_MORE[0])
        record("menu: Show me activates the moved tab", bool(sel) and sel["selected"], json.dumps(sel))
        handle = open_popup_tab(client)  # the popup tab closed itself
        popup_click(client, handle, "label.switch")
        st = popup_state(client, handle)
        add_tab(client, TRAVEL_MORE[2])
        wait_loaded(client, [TRAVEL_MORE[2]])
        time.sleep(6)
        still_loose = find(client, TRAVEL_MORE[2])["group"] is None
        travel3 = next((g for g in groups(client) if g["label"] == "Travel"), None)
        record("menu: off → new travel tab stays loose, groups kept", (not st["enabled"]) and still_loose and travel3 and len(travel3["tabs"]) == 4,
               json.dumps({"state": st, "tab": find(client, TRAVEL_MORE[2])}))
        popup_click(client, handle, "label.switch")
        st = popup_state(client, handle)
        time.sleep(4)
        not_regrouped = find(client, TRAVEL_MORE[2])["group"] is None
        add_tab(client, TRAVEL_MORE[3])
        wait_loaded(client, [TRAVEL_MORE[3]])
        rejoined = wait_for(lambda: (lambda t: t and t["group"] == "Travel")(find(client, TRAVEL_MORE[3])), 25)
        record("menu: on → earlier loose tab untouched, next travel tab joins", st["enabled"] and not_regrouped and bool(rejoined),
               json.dumps(find(client, TRAVEL_MORE[3])))
        before = {t["e2e"]: t["index"] for t in tab_info(client) if t["e2e"] in RECIPES}
        popup_click(client, handle, "#sw-autogroup-undo")
        time.sleep(2)
        gone = not any(set(RECIPES) <= set(g["tabs"]) for g in groups(client))
        after = {t["e2e"]: t["index"] for t in tab_info(client) if t["e2e"] in RECIPES}
        # The popup tab closes itself on undo; reopen it to check the disabled state.
        handle = open_popup_tab(client)
        st = popup_state(client, handle)
        record("menu: undo dissolves the auto group in place; reopened menu shows Nothing to undo",
               gone and before == after and st["undoDisabled"] and st["undoDesc"] == "Nothing to undo",
               json.dumps({"before": before, "after": after, "state": st}))

        # ---- on-device model ----------------------------------------------------------------------
        if not args.skip_model:
            granted = grant_trial_ml(client)
            ready = None
            for attempt in range(3):
                # A fresh profile may not have synced the ML runtime from Remote Settings yet; retry.
                popup_click(client, handle, "#model-enable")
                ready = wait_for(lambda: "ready" in popup_state(client, handle)["model"].lower() or None, 150, step=3)
                st = popup_state(client, handle)
                if ready or "Remote Settings" not in st["model"]:
                    break
                print(f"   model attempt {attempt + 1} failed: {st['model']}; retrying in 20s", flush=True)
                time.sleep(20)
            st = popup_state(client, handle)
            record("model: trial.ml engine ready", bool(ready), f"perm={granted} status={st['model']}")
            if ready:
                sim = debug_sim(client, handle, TRAVEL_TITLES)
                m = sim.get("model") or [[0] * 4] * 4
                cross_site_ok = m[0][1] >= 0.45 and m[0][2] >= 0.45 and m[1][2] >= 0.45
                unrelated_ok = max(m[0][3], m[1][3], m[2][3]) < 0.35
                record("model: cross-site travel titles score ≥0.45, Gmail <0.35 (embeddings only)",
                       sim.get("backend") == "model" and cross_site_ok and unrelated_ok,
                       "model rows: " + "; ".join(" ".join(f"{v:.2f}" for v in row) for row in m))
                for u in RECIPES:  # leftover loose recipe tabs would otherwise join the cluster
                    close_tab(client, u)
                time.sleep(1)
                add_tab(client, MODEL_SET[0]); add_tab(client, MODEL_SET[1])
                wait_loaded(client, MODEL_SET[:2])
                time.sleep(6)
                add_tab(client, MODEL_SET[2])
                wait_loaded(client, [MODEL_SET[2]])
                mg = wait_for(lambda: next((g for g in groups(client) if set(MODEL_SET) <= set(g["tabs"])), None), 40)
                record("model: cross-domain food pages form one group", bool(mg), json.dumps(mg or groups(client)))
                st = popup_state(client, handle)
                print("   log:", st["log"].replace("\n", " | "))
    finally:
        n_ok = sum(1 for _, ok, _ in results if ok)
        print(f"\n{n_ok}/{len(results)} passed")
        if args.keep:
            print(f"Firefox left running (pid {proc.pid}), profile {profile}")
        else:
            try:
                client.quit()
            except Exception:
                pass
            proc.terminate()
            try:
                proc.wait(10)
            except Exception:
                proc.kill()
            shutil.rmtree(profile, ignore_errors=True)
    sys.exit(0 if n_ok == len(results) else 1)


if __name__ == "__main__":
    main()
