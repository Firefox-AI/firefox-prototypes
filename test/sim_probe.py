#!/usr/bin/env python3
"""Print model similarity matrices for a few title sets, to tune the threshold.
Run: cd <worktree> && ./mach python <ext>/test/sim_probe.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e  # noqa: E402
from marionette_driver.addons import Addons  # noqa: E402
from marionette_driver.marionette import Marionette  # noqa: E402

SETS = {
    "food cross-domain": [
        {"title": "Pancake - Wikipedia", "url": "https://en.wikipedia.org/wiki/Pancake"},
        {"title": "Cookbook:Waffles - Wikibooks, open books for an open world", "url": "https://en.wikibooks.org/wiki/Cookbook:Waffles"},
        {"title": "Crêpe - Simple English Wikipedia, the free encyclopedia", "url": "https://simple.wikipedia.org/wiki/Cr%C3%AApe"},
        {"title": "Coimbra – Travel guide at Wikivoyage", "url": "https://en.wikivoyage.org/wiki/Coimbra"},
        {"title": "GitHub - mozilla-firefox/firefox: The official repository of Mozilla Firefox", "url": "https://github.com/mozilla-firefox/firefox"},
    ],
    "travel cross-domain": [
        {"title": "Lisbon – Travel guide at Wikivoyage", "url": "https://en.wikivoyage.org/wiki/Lisbon"},
        {"title": "Cheap Flights to Lisbon from $312 | Kayak", "url": "https://www.kayak.com/flights/SFO-LIS"},
        {"title": "Hotel Avenida Palace, Lisbon – Booking.com", "url": "https://www.booking.com/hotel/pt/avenida-palace.html"},
        {"title": "The 10 Best Things to Do in Porto - Tripadvisor", "url": "https://www.tripadvisor.com/Attractions-g189180"},
        {"title": "Inbox (3) - Gmail", "url": "https://mail.google.com/mail/u/0/"},
        {"title": "Quarterly planning doc - Google Docs", "url": "https://docs.google.com/document/d/abc"},
    ],
}


def main():
    port = e2e.free_port()
    proc, profile = e2e.launch(e2e.NIGHTLY, port)
    client = Marionette(host="127.0.0.1", port=port, startup_timeout=90)
    try:
        client.start_session()
        client.set_context("chrome")
        Addons(client).install(e2e.EXT_DIR, temp=True)
        time.sleep(2)
        print("grant:", e2e.grant_trial_ml(client))
        handle = e2e.open_popup_tab(client)
        e2e.popup_click(client, handle, "#model-enable")
        ready = e2e.wait_for(lambda: "ready" in e2e.popup_state(client, handle)["model"].lower() or None, 180, step=3)
        print("model ready:", bool(ready), e2e.popup_state(client, handle)["model"])
        for name, tabs in SETS.items():
            res = e2e.debug_sim(client, handle, tabs)
            print(f"\n== {name} [{res['backend']}]")
            for i, t in enumerate(res["texts"]):
                row = " ".join(f"{v:5.2f}" for v in res["matrix"][i])
                mrow = " ".join(f"{v:5.2f}" for v in (res["model"][i] or [])) if res.get("model") else ""
                print(f"  combined {row}   model {mrow}   {t}")
    finally:
        try:
            client.delete_session()
        except Exception:
            pass
        proc.terminate()


if __name__ == "__main__":
    main()
