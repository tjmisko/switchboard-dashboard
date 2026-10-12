# Switchboard display modes — 2026-09-11

Implemented in Switchboard commit `13ded3ba511d0cd6e206720d331bcffce522e51b`
on `feat/display-modes`, based on the activated Waybar ownership repair
`be2bf97b72f6176625db6a1d65c1b3009968cfe0`.

The implementation and full design documentation are in the local worktree
`.worktrees/switchboard-display-modes` (`docs/display-modes.md` there).
The original `~/Projects/switchboard` checkout remains on `be2bf97` until host
activation fast-forwards it. The existing pricing reconciliation and Waybar
ownership repair are retained.

## Behavior

- Switchboard's ordered session view supplies shared status, identity and
  next/previous navigation. Presentation changes never change the list or its
  navigation order. An empty navigable list is a valid no-op.
- `switchboard-ctl display mode chips|circles|toggle` changes a persistent
  preference. The default remains the existing named bottom chips.
- **Super+Shift+B** toggles between the bottom chips and circles at the right
  end of the desktop's existing top Waybar. Existing navigation, picker,
  attention and F8 master-visibility bindings are preserved.
- Circles are separate GTK widgets with no visible text and no fixed session
  limit. They retain chip status colors, focus and remote borders, tooltips,
  and generation-scoped click targets. Scrolling navigates sessions.
- The unused top-bar `custom/task` timer is removed from the prepared config.
- A single broker publishes the complete versioned `display.json` frame.
  `switchboard-ctl display watch` provides JSON lines for other consumers.
  Sessions, mode changes and owned-child exits trigger live updates. The
  embedded module uses file events and a publisher pidfd, hiding on disconnect
  or publisher death.
- Mode transitions retain bottom-process ownership until exit. A separate
  lifetime lock rejects competing display brokers.

## Activation

Run from a terminal in the desktop session:

```bash
python3 ~/Projects/switchboard-dashboard/.bin/display-modes-20260911/activate.py
```

The prepared bundle contains all three Go binaries, a native Waybar extension,
the full CLI race-test executable, a Git bundle, exact host config outputs,
SHA-256 checksums, and a tested activation script. `--check` performs a read-only
preflight. The script verifies the current source/release/configuration,
runs the full CLI race tests on the host, fast-forwards Switchboard, installs
an immutable release, updates resolved config targets while preserving their
symlinks, reloads Hyprland and the identified desktop Waybar, and restarts only
previously active Switchboard units.

Verification checks the running binaries, the native module loaded by the
existing top process, and bottom-process ownership. Failed runtime checks
restore the previous release and configuration from a recorded backup; source
retains the feature commit. User config changes since preparation cause an
early stop. Inactive units remain inactive. If the broker was explicitly
stopped, the script prints the command to start it when desired.

An activation attempt from this workspace passed artifact/source/config
preflight but failed at the first `systemctl --user show` with “Failed to connect
to user scope bus … Operation not permitted.” No live source, release, config
or service changes were made. Activation and a desktop visual check remain
pending.

## Verification performed

- Race tests passed for the CLI (excluding sandbox-blocked hook socket tests),
  Polybar adapter, shared session view, display contract, Waybar renderer,
  state ordering, service definitions and Waybar configuration.
- All Go packages/test files compiled; vet passed for the affected controller
  and shared display/view packages.
- The live transition test uses real child processes and inotify: circles
  remain hidden while a terminating bottom bar is alive, appear immediately
  on its exit without a new session snapshot, and hide before chips restart.
- Native adapter tests use real GLib file events and pidfds with a GTK test
  double: 32 circles, stable widget identity/reordering, live status updates,
  hidden/empty modes, publisher death/recovery, and cleanup passed.
- The native library loaded against the installed GTK runtime. GTK accepted
  the full generated stylesheet including the existing chip stylesheet and
  new circle stylesheet. Lua syntax and three configuration-helper tests
  passed.
- Eight activation tests passed, including symlink preservation, stopped-unit
  preservation, config-change detection, pre-mutation host/test failures,
  and restoration after a failed native-module load.
- Dashboard `TestPricingProviderContract` passed against the exact new CLI
  release binary.

The original Switchboard checkout and linux-config files were not modified
from the workspace. Dashboard's unrelated untracked
`docs/rust-rewrite-requirements.md` was left alone.
