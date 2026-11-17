#!/usr/bin/env node
// Quick check of the live site (run from your own computer, read-only):
//   SITE=https://your-site.vercel.app OWNER_KEY=... node scripts/smoke.js
// Checks the pages answer, the owner endpoints work with the key and refuse without it, and prints what the logs hold.
// It does NOT log in with LINE, so it can't test creating trips; do that by hand (see the checklist printed at the end).
const SITE = (process.env.SITE || "").replace(/\/$/, ""), KEY = process.env.OWNER_KEY || "";
if (!SITE) { console.error("set SITE=https://... first"); process.exit(1); }
let bad = 0;
const ok = (name, pass, extra) => { if (!pass) bad++; console.log((pass ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };
(async () => {
  for (const p of ["/", "/plans", "/privacy", "/terms", "/home"]) { const r = await fetch(SITE + p, { redirect: "manual" }).catch(() => null); ok("page " + p, !!r && r.status < 400, r ? String(r.status) : "no answer"); }
  const noKey = await fetch(SITE + "/api/owner?audit=1").catch(() => null);
  ok("owner refuses without key", !!noKey && (noKey.status === 403 || noKey.status === 404), noKey ? String(noKey.status) : "no answer");
  if (!KEY) { console.log("(no OWNER_KEY given: skipping owner checks)"); }
  else {
    const H = { "x-owner-key": KEY }, get = async (q) => { const r = await fetch(SITE + "/api/owner" + q, { headers: H }).catch(() => null); return { s: r ? r.status : 0, j: r ? await r.json().catch(() => ({})) : {} }; };
    const a = await get("?audit=1"); ok("activity log readable", a.s === 200, (a.j.rows || []).length + " rows");
    const e = await get("?errors=1"); ok("error log readable", e.s === 200, (e.j.rows || []).length + " rows" + ((e.j.rows || []).length ? " (look at them on /owner)" : ""));
    const l = await get("?ledger=1"); ok("ledger readable", l.s === 200, l.j.n + " rows, net " + l.j.net + " THB");
    const o = await get("?orders=1"); ok("orders readable", o.s === 200, "Stripe " + o.j.mode + (o.j.stripe ? "" : " (key not set)"));
  }
  console.log("\nBy hand (needs your LINE login):\n 1. create a trip dated in the past -> must be refused (bad_pastdate)\n 2. create, edit, delete a test trip within 24h -> /owner activity log shows 3 lines, delete says quota given back\n 3. press 'ย้ายออเดอร์เก่า' once on /owner, then check the revenue card\n 4. open the site inside LINE on iPhone and Android: bottom bar, close buttons, toasts\n 5. in Upstash, check automatic backups are on; or run scripts/dump.js now and then");
  process.exit(bad ? 1 : 0);
})();
