# Smart Window Prototype

Launch with:

```text
./mach run --new-instance --profile /private/tmp/smart-window-prototype-profile --chrome 'chrome://browser/content/aiwindow/firstrun.html?prototype=1'
```

Click path:

1. Select the Firefox import tile, continue through profile import and privacy preferences, then Finish.
2. Type `find me the best places to eat in scottsdale az` in the new-tab omnibox.
3. Press Enter for the inline Search AI answer, or choose the Ask Smart Window suggestion row to open the docked assistant.
4. In the assistant, send the seeded query, use suggested prompts, send follow-ups, copy/regenerate messages, and open the overflow menu for history.
5. Type `fail` in the composer to trigger the inline retry state.

The flow is mock-only: no live model, tab-reading, import, media capture, map provider, telemetry, or network request is used.
