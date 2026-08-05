#!/usr/bin/env node
// Benchmark the dashboard's day transitions against a running server.
//
// The two numbers it reports are the two a user actually experiences:
//
//   first frame — from the call that changes the day to the browser having
//     painted SOMETHING about the new day. With the scaffold in place this is
//     the frame with the new axis and the placeholders; without it, it is the
//     same instant as the data, because nothing was drawn until the data came.
//   to data     — from that same call to the day's real content being on
//     screen. Cache hits land here immediately; a cold day waits on ctl.
//
// Both finish lines are two nested requestAnimationFrames after the DOM work:
// the first fires before the coming paint, the second after it. A render
// function returning is not the user seeing anything, and timing to the former
// flatters every result by a frame or more.
//
// Usage:
//   node scripts/bench-day-transition.mjs [--url URL] [--rounds N] [--cdp PORT]
//                                         [--walk d1,d2,...] [--compare URL] [--cold]
//
// Requires a headless Chrome with the devtools port open:
//   google-chrome --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=$(mktemp -d) about:blank
//
// --compare runs a second server through the identical walk and prints both,
// ALTERNATING nothing — they run back to back on the same machine in the same
// minute, which is the only way the comparison means anything. That is how the
// before/after table in the README was produced: two builds of this repo, the
// same real history behind both.

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const CDP_PORT = flag("cdp", "9222");
const ROUNDS = Number(flag("rounds", "3"));
// A walk a person would actually do: back through the week, then forward again.
// Repeats are deliberate — they are what a day cache is for, and a walk with no
// revisits measures only the cold path.
const WALK = flag("walk", "").split(",").filter(Boolean);
const COLD = args.includes("--cold");
const TARGETS = [["current", flag("url", "http://localhost:8080")]];
if (flag("compare", null)) TARGETS.push(["compare", flag("compare")]);

// --------------------------------------------------------------------------
// CDP: connect to the existing page target and drive it by evaluating in-page.
// --------------------------------------------------------------------------
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target on CDP port ${CDP_PORT}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    for (const fn of waiters) fn(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error("in-page eval threw: " +
        (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  };
  const navigate = async (url) => {
    await send("Page.enable");
    const loaded = new Promise((res) => waiters.push((m) => { if (m.method === "Page.loadEventFired") res(); }));
    await send("Page.navigate", { url });
    await loaded;
  };
  return { evaluate, navigate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// The in-page timer. Installed once per target; measures one day change.
//
// It watches lastTimelineText rather than any render hook, because that is the
// one variable both the old and new code paths agree means "the day's bytes are
// what is on screen" — so the same probe measures a build that predates all of
// the transition work.
//
// The loadingDay clause is load-bearing and was a bug before it was there: the
// scaffold blanks lastTimelineText on its way up, so "changed from what it was"
// fires at the SCAFFOLD, and a cold day reported the scaffold's ~30ms as its
// time-to-data. Data is on screen when the bytes are non-empty, different, AND
// no scaffold is up. Old builds have no loadingDay, hence the typeof.
// --------------------------------------------------------------------------
const INSTALL = `
(() => {
  window.__bench = { rows: [] };
  window.__bench.step = async (day, cold) => {
    // --cold empties the day cache before every step, so each one is a genuine
    // miss. It isolates what the SCAFFOLD is worth from what the CACHE is worth:
    // a warm walk credits both to one number and hides how long a cold day is.
    if (cold && typeof dayCache !== "undefined") dayCache.clear();
    const before = lastTimelineText;
    const painted = () => lastTimelineText !== before && lastTimelineText !== ""
      && (typeof loadingDay === "undefined" || loadingDay === null);
    const t0 = performance.now();
    commitDay(day);
    const deadline = t0 + 15000;
    while (!painted() && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const total = performance.now() - t0;
    // firstFrame comes from the page's own profiling when it is present; a build
    // without it only ever HAS one frame, so total is the honest answer there.
    const rec = (typeof perfLog !== "undefined" && perfLog.length) ? perfLog[perfLog.length - 1] : null;
    const ff = rec && rec.marks ? rec.marks.firstFrame : null;
    const row = { day, total, firstFrame: ff == null ? total : ff, source: rec ? rec.source : null };
    window.__bench.rows.push(row);
    return row;
  };
  return "ok";
})()`;

async function run(cdp, label, url, walk) {
  // ?perf=1 turns on the page's own instrumentation, which is where firstFrame
  // comes from. A build without it ignores the parameter.
  await cdp.navigate(url + "/?day=" + walk[walk.length - 1] + "&perf=1");
  await sleep(6000); // first load, entry sweep, and the neighbour prefetch
  await cdp.evaluate(INSTALL);
  for (let r = 0; r < ROUNDS; r++) {
    for (const day of walk) {
      await cdp.evaluate(`window.__bench.step(${JSON.stringify(day)}, ${COLD})`);
      // Reading time. Also what lets the prefetch run — leaving it out measures a
      // machine-gun that no one operates, and starves the feature under test.
      await sleep(900);
    }
  }
  return { label, url, rows: JSON.parse(await cdp.evaluate("JSON.stringify(window.__bench.rows)")) };
}

// --------------------------------------------------------------------------

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (xs, p) => {
  const v = xs.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
};
const ms = (v) => v.toFixed(0).padStart(6) + "ms";

// defaultWalk builds the walk from today backwards, so the benchmark exercises
// days that exist in whatever history is behind the server rather than dates
// hard-coded to whenever this was written.
function defaultWalk() {
  const d = new Date();
  const iso = (back) => {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  return [iso(1), iso(2), iso(3), iso(2), iso(1), iso(0)];
}

const walk = WALK.length ? WALK : defaultWalk();
const cdp = await connect();
const results = [];
for (const [label, url] of TARGETS) results.push(await run(cdp, label, url, walk));
await cdp.close();

console.log(`\nwalk: ${walk.join(" -> ")}`);
console.log(`rounds: ${ROUNDS}   n=${ROUNDS * walk.length} per target\n`);
console.log("target    metric                  mean      p50      p95      max");
for (const { label, rows } of results) {
  const ff = rows.map((r) => r.firstFrame);
  const tot = rows.map((r) => r.total);
  const line = (name, xs) =>
    `${label.padEnd(9)} ${name.padEnd(22)} ${ms(mean(xs))} ${ms(pct(xs, 0.5))} ${ms(pct(xs, 0.95))} ${ms(Math.max(...xs))}`;
  console.log(line("time to first frame", ff));
  console.log(line("time to day's data", tot));
  // Where the two numbers come apart: a cache hit's data IS its first frame, a
  // cold day's is whatever ctl took. Reporting only the blended mean would let a
  // warm walk hide how long a cold day still is.
  if (rows.some((r) => r.source)) {
    const hits = rows.filter((r) => r.source === "cache");
    const cold = rows.filter((r) => r.source === "network");
    console.log(`${" ".repeat(10)}cache ${hits.length}/${rows.length}` +
      (cold.length ? `   cold to-data mean: ${ms(mean(cold.map((r) => r.total)))} (n=${cold.length})` : "") +
      (hits.length ? `   warm to-data mean: ${ms(mean(hits.map((r) => r.total)))}` : ""));
  }
}

if (results.length === 2) {
  const [a, b] = results;
  const r = (x, y) => (mean(x) / mean(y)).toFixed(1) + "x";
  console.log(`\n${a.label} -> ${b.label}:` +
    `  first frame ${r(a.rows.map((x) => x.firstFrame), b.rows.map((x) => x.firstFrame))} faster,` +
    `  to data ${r(a.rows.map((x) => x.total), b.rows.map((x) => x.total))} faster`);
}
