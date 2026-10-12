# Larger circles and shared hover cards

Switchboard commit `4b09ce7252cc0baa28f6d887820d7b2fe866fc28`, on
`feat/display-modes`, extends the activated `13ded3b` display-mode release.

- Circle diameter increases from 16px to 24px; normal borders increase from
  1px to 3px. Remote sessions use 6px double borders with the same overall
  diameter. Status colors and focus treatment remain the same.
- Circles use the exact bottom-chip Pango formatter through
  `waybarchip.TooltipMarkup`: project/path, host, status, task, timing,
  workspace, PID, and agent summary. User text remains escaped.
- The display frame keeps its plain-text `tooltip` and adds optional
  `tooltip_markup`. The native adapter renders markup when available and
  retains its plain-text fallback for older frames.
- Unchanged tooltip text is retained across other sessions' updates. One
  adaptive timer refreshes coarse hover durations across the entire circle
  list, including sessions beyond the ten bottom-bar slots.

Run from the desktop terminal:

```bash
python3 ~/Projects/switchboard-dashboard/.bin/circle-hover-polish-20260911/activate.py
```

The bundle uses the previous tested activation workflow: checked source and
configuration hashes, full CLI race tests on the host, immutable release,
preserved config symlinks/stopped services, and runtime/config rollback.
Its read-only preflight passed. Workspace activation stopped at the first
systemd user-bus query with `Operation not permitted`, before any live changes.

Verification passed: affected Go race tests (CLI hook socket tests deferred
to host activation), exact top/bottom tooltip parity for 25 sessions,
quiet-session minute-boundary refresh beyond the bottom slots, native GLib
adapter tests with markup/plain fallback and unchanged-card retention,
GTK parsing of the full stylesheet, Lua syntax, and eight activation tests.
Desktop visual verification remains pending activation.
