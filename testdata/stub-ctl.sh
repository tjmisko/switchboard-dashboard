#!/bin/sh
# stub-ctl.sh — a fake `switchboard-ctl` for dashboard development/screenshots.
# It ignores every flag and prints the committed full-detail timeline fixture,
# so `switchboard-dashboard --ctl testdata/stub-ctl.sh` renders the v2 contract
# without a real Switchboard install. Resolve the fixture relative to this
# script so it works from any CWD.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cat "$here/timeline/2026-06-26-full.json"
