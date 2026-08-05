#!/bin/sh
# stub-ctl.sh — a fake `switchboard-ctl` for dashboard development/screenshots.
# It ignores every flag and prints the committed fixture for the requested
# subcommand, so `switchboard-dashboard --ctl testdata/stub-ctl.sh` renders the
# v2 contract without a real Switchboard install. Resolve the fixtures relative
# to this script so it works from any CWD.
#
# The memory fixture's session ids match the timeline fixture's lanes, so the
# hover enrichment has something to bind to. Anything other than `memory` serves
# the timeline: the dashboard's default provider invokes this as
# `stub-ctl.sh timeline --json --plan-window`.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$1" in
memory) cat "$here/memory/2026-06-26-full.json" ;;
*) cat "$here/timeline/2026-06-26-full.json" ;;
esac
