# Waybar duplicate bottom bars: September 11, 2026

Status: the repair is committed as Switchboard `be2bf97` and packaged locally; host activation is pending. See "Prepared repair" below.

The bottom-bar watcher has a reproducible startup identity race: it can erase a live child's PID record during an early `/proc/<pid>/cmdline` check, then start another child. This explains the two bottom rows in the screenshot. Historical journal records prove the double launch; an isolated reproduction identifies the destructive validation path. The journal does not record the failed identity check itself, so attributing that specific historical check to an empty command line is an inference supported by the reproduction.

## Journal evidence

All times are America/Los_Angeles on September 11, 2026:

| Time | Event |
| --- | --- |
| 11:43:07.976509 | systemd stops `switchboard-waybar.service` during pricing activation. |
| 11:43:07.981712 | systemd starts the replacement watcher. |
| 11:43:08.142897 | Waybar PID 1084548 logs loading `~/.config/waybar/claude.jsonc`. |
| 11:43:08.165801 | Waybar PID 1084573 logs loading the same configuration. |
| 11:43:08.210 | Both processes configure bars on eDP-1 and HDMI-A-1. |

The configuration log messages are 22.904 milliseconds apart; those are log timestamps, not exact fork timestamps. Both have `_SYSTEMD_USER_UNIT=switchboard-waybar.service` and `_SYSTEMD_INVOCATION_ID=3ff016cfd83f4b84b6d07658ae5dd006`. Both executables are `/usr/bin/waybar`, with `waybar -c /home/tjmisko/.config/waybar/claude.jsonc` as their command line.

The runtime PID record contains only `1084573 1125301`; the readiness record also contains `1084573`. The second child owns subsequent slot signals. The untracked first child's modules can retain earlier values, consistent with the screenshot's different chip colors.

The combined-profile marker is absent and `switchboard-waybar-publisher.service` was skipped for its unmet marker condition. The split bottom configuration contains one bar definition. The top bar is a separate expected desktop process.

This predates pricing activation: September 8 at 18:29:39.628940 and 18:29:39.653537, PIDs 1543410 and 1543426 loaded the same bottom configuration following one watcher restart. Today's activation triggered another opportunity for the existing launch bug.

## Code path at Switchboard 69ca5cf

File: `cmd/switchboard-ctl/bottombar.go`.

1. `startBottom` (line 665) calls `cmd.Start()`, records PID plus process start time, and releases the child handle.
2. The render loop immediately calls `scheduleReady` after reconciliation (lines 455–456).
3. `flushSlotsWhenReady` (line 551) calls `openBottomProcess`, before the module readiness gate.
4. `openBottomProcess` (line 830) treats every command identity failure as stale ownership. Its failure closure deletes the PID record without stopping the child.
5. `bottomCommandMatches` (line 895) returns false when the process command line is temporarily empty during exec.
6. The next `ensureStarted` (line 634) sees no record and spawns another Waybar. The first remains alive, but is no longer tracked for updates or normal lifecycle stops.

The flock serializes these operations; the incorrect state transition occurs even with one caller. Linux applies close-on-exec handling during `begin_new_exec`, before all exec setup has completed. The parent returning from its launch handshake therefore does not guarantee the new command line is already readable. See the [Linux exec implementation](https://github.com/torvalds/linux/blob/master/fs/exec.c) and [ELF loader](https://github.com/torvalds/linux/blob/master/fs/binfmt_elf.c).

## Reproduction

Used an isolated worktree at `.worktrees/switchboard-waybar-double-spawn`, based on the installed Switchboard commit. No graphical client was launched: a tiny compiled helper named `waybar` accepts the expected command arguments and waits for a signal. Each iteration calls the actual `startBottom` and `openBottomProcess`, then explicitly kills and reaps its own helper children.

- Unmodified production code rejected 2 live children in 1,000 launches.
- A second run added logging only at the existing identity checks. In 10,000 launches, 12 live children were rejected. All 12 logged an empty command line with no read error.
- After each rejection, the same child still existed with its original start time and the correct `waybar -c ...` identity, while its PID file had been deleted.
- Calling the actual `ensureStarted` then launched a different PID while the original child remained alive.
- The instrumented run completed in 4.53 seconds. Counts are timing-dependent and are not estimates of desktop incident frequency.

Example captured output:

```text
REPRO cmdline empty pid=3866 err=<nil>
rejected LIVE child pid=3866 ... generationMatches=true pidfileDeleted=true
next reconcile spawned pid=3867 while first pid=3866 alive=true
Actual startBottom/openBottomProcess rejected 12/10000 live launches
```

Evidence is retained locally in `.bin/waybar-double-spawn-20260911/`: `journal.jsonl`, `reproduction.log`, the helper C source, diagnostic Go test, and logging-only patch. The investigation worktree retains the diagnostic test; its production source has been restored to the original commit. Installed binaries and live services were not changed during this investigation.

## Repair direction

Preserve ownership of a newly launched child until its exit is confirmed. Treat startup identity/readiness as a separate state from absence. A bounded startup verification can retry transient proc reads while retaining the child handle; if verification fails, terminate and reap that owned child before allowing a replacement. Keep the existing PID-generation and pidfd protections for signaling. Record launch PID, validation failure reason, and replacement decisions in the journal.

Add deterministic coverage for transiently unavailable command identity, proving that reconciliation cannot launch a replacement while the original owned generation remains alive. Also cover startup failure cleanup and stale/reused PID rejection. The current idempotence test uses an immediately-running stub and does not exercise this startup window.

Restarting the bottom-bar unit can clear its current children, but the same race can recur until lifecycle handling is corrected. No repair has been deployed as part of this diagnosis.


## Prepared repair

Switchboard commit `be2bf97b72f6176625db6a1d65c1b3009968cfe0` on branch
`fix/waybar-process-ownership` is in the isolated checkout at
`.worktrees/switchboard-waybar-double-spawn`.

- A recorded PID and start time establish ownership immediately at launch.
  Mutable command metadata is checked only when adopting legacy PID-only records.
- pidfd exit polling distinguishes an exited generation from a child still
  starting or stopping. Uncertain reads retain ownership and block replacement.
- SIGTERM requests retain ownership until exit is observed, including when a
  child delays or ignores the signal.
- Each launched child has its own Wait call; the global Wait4 reaper is removed.
- Launch, exit, and identity validation outcomes now appear in the journal.

Validation:

- The deterministic startup regression fails with the original production code
  and passes with the repair. Additional tests cover readiness, delayed shutdown,
  replacement after exit, generation mismatch, and ownership read failures.
- The original stress harness, adapted to the child-specific reaper, completed
  10,000 launches with zero lost live children. The instrumented baseline lost
  12 in 10,000. These counts demonstrate the bug and exercise its repair; they
  are not estimates of desktop incident frequency.
- CLI race tests pass with the existing `TestCmdHookShould*` tests excluded.
  Those tests require Unix sockets, which the agent sandbox denies. The full
  CLI race-test executable is packaged and must pass on the host before the
  installer makes changes.
- Waybar renderer race tests, CLI vet, all three release builds, and the
  dashboard's real-CLI pricing contract test pass.
- Four isolated installer tests cover success, preserving a stopped bottom-bar
  unit, failure before mutation, and release rollback after verification failure.

To keep the bottom bar stopped while working, stop its owner rather than
killing an active service's processes:

```bash
systemctl --user stop switchboard-waybar.service
```

Install from a host terminal:

```bash
python3 ~/Projects/switchboard-dashboard/.bin/waybar-ownership-fix-20260911/activate.py
```

The installer checks artifact hashes and source ancestry, runs the full CLI
race tests, fast-forwards `~/Projects/switchboard`, installs matching immutable
binaries, and flips the shared `current` symlink. It uses `try-restart` only for
units that were active, then checks running executable hashes and the bottom
renderer's child count. It preserves stopped units and restores the previous
release if runtime verification fails. The host source must still be clean and
at `69ca5cf` or the prepared repair revision.

The agent attempted activation with escalation; the systemd user bus still
returned `Operation not permitted`. Activation stopped before source or release
mutation. This was a runtime access restriction, not an automatic approval
review rejection.
