// Packages (Free / Standard / Premium) and per-trip passes. Organizers pay; booking a seat is always free.
// Everything is a one-time payment that adds time (PromptPay can't be charged automatically every month), so a
// "monthly" plan is 30 days and a "yearly" plan 365 days; buying again extends it.
//
// Redis:
//   plan:<uid>    = {tier, until (ms), src}     no key / expired -> Free
//   passes:<uid>  = number of unused per-trip passes
//   trip.plus     = true on a trip that used a pass (that trip gets Standard limits and doesn't count toward "open trips")
//   order:<id>    = {id, uid, name, sku, amount, status ("open"|"paid"|"expired"), at, paidAt, sess}   kept 400 days
//   orders:<uid>  = list of the account's order ids (newest first)     orders:all = every order id (owner console)
//
// Switched on with PLANS_ON=1 (production) — always on for previews and local dev. While off nothing is limited
// (the limits are the old fixed ones) and the app hides every package screen.
const L = require("./_lib");

const DAY = 86400 * 1000;
const LAUNCH_GIFT_DAYS = 90; // accounts that already organized trips before packages started get Standard for free this long

const TIERS = {
  free: { name: "Free", trips: 2, vans: 1, helpers: 0, rounds: 1 },
  standard: { name: "Standard", trips: 20, vans: 5, helpers: 2, rounds: 0 },
  premium: { name: "Premium", trips: 0, vans: 10, helpers: 5, rounds: 0 }, // 0 = no limit
};
// while packages are off: the limits the app always had
const LEGACY = { name: "", trips: 0, vans: 5, helpers: 2, rounds: 0 };

const SKUS = {
  pass: { kind: "pass", label: "ตั๋วรายทริป 1 ใบ", amount: 39 },
  std_m: { kind: "plan", tier: "standard", days: 30, label: "Standard 1 เดือน", amount: 149 },
  std_y: { kind: "plan", tier: "standard", days: 365, label: "Standard 1 ปี", amount: 1490 },
  pre_m: { kind: "plan", tier: "premium", days: 30, label: "Premium 1 เดือน", amount: 399 },
  pre_y: { kind: "plan", tier: "premium", days: 365, label: "Premium 1 ปี", amount: 3990 },
};

const DEV = process.env.VSB_DEV_AUTH === "1" && !process.env.VERCEL;
function enabled() {
  if (process.env.PLANS_ON === "1") return true;
  if (process.env.PLANS_ON === "0") return false;
  return DEV || process.env.VERCEL_ENV === "preview";
}

function planKey(uid) { return "plan:" + uid; }
function passKey(uid) { return "passes:" + uid; }

// {tier, until, src, passes} for one account; gives the launch gift once to accounts that already had trips
async function getPlan(uid) {
  if (!uid) return { tier: "free", until: 0, passes: 0 };
  const [raw, passes, hadTrips] = await L.pipeline([["GET", planKey(uid)], ["GET", passKey(uid)], ["EXISTS", L.myTripsKey(uid)]]);
  let p = null;
  try { p = raw ? JSON.parse(raw) : null; } catch (e) { p = null; }
  if (!p && Number(hadTrips) === 1 && enabled()) {
    p = { tier: "standard", until: Date.now() + LAUNCH_GIFT_DAYS * DAY, src: "gift" };
    try { await L.redis(["SET", planKey(uid), JSON.stringify(p), "NX"]); } catch (e) { /* best effort */ }
  }
  if (!p) p = { tier: "free", until: 0, src: "" }; // first look: remember "free" so a later first trip doesn't count as an old account
  if (!raw && p.tier === "free" && enabled()) { try { await L.redis(["SET", planKey(uid), JSON.stringify(p), "NX"]); } catch (e) { /* best effort */ } }
  const live = p.tier !== "free" && p.until > Date.now();
  return { tier: live ? p.tier : "free", until: live ? p.until : 0, src: live ? p.src || "" : "", lastTier: p.tier, lastUntil: p.until || 0, passes: Math.max(0, Number(passes) || 0) };
}

// limits for one trip: the owner's package, or Standard when the trip used a pass (whichever is bigger)
function limitsFor(plan, trip) {
  if (!enabled()) return Object.assign({ tier: "", on: false }, LEGACY);
  const own = TIERS[plan && plan.tier] || TIERS.free;
  const lim = Object.assign({ tier: (plan && plan.tier) || "free", on: true }, own);
  if (trip && trip.plus) {
    const s = TIERS.standard;
    ["vans", "helpers"].forEach((k) => { if (lim[k] !== 0 && lim[k] < s[k]) lim[k] = s[k]; });
    if (lim.rounds !== 0) lim.rounds = 0;
    lim.plus = true;
  }
  return lim;
}

// the owner's trips that are still open (not finished) and don't use a pass: they count toward the package's limit
async function openTripCount(uid) {
  const ids = ((await L.redis(["SMEMBERS", L.myTripsKey(uid)])) || []).map(String).filter((x) => L.tripId(x));
  if (!ids.length) return 0;
  const raws = await L.pipeline(ids.map((id) => ["GET", L.tripKey(id)]));
  let n = 0;
  raws.forEach((raw) => { try { const t = JSON.parse(raw); if (t && t.owner === uid && !t.plus && !L.tripEnded(t)) n++; } catch (e) { /* skip */ } });
  return n;
}

async function usePass(uid) { // takes one pass; false when there is none
  const n = Number(await L.redis(["DECR", passKey(uid)]));
  if (n < 0) { try { await L.redis(["INCR", passKey(uid)]); } catch (e) { /* best effort */ } return false; }
  return true;
}
async function refundPass(uid) { try { await L.redis(["INCR", passKey(uid)]); } catch (e) { /* best effort */ } }

// adds a paid (or owner-granted) package / pass to the account
async function grant(uid, sku, src) {
  const s = SKUS[sku];
  if (!s) throw new Error("bad_sku");
  if (s.kind === "pass") { await L.redis(["INCR", passKey(uid)]); return; }
  let cur = null;
  try { cur = JSON.parse(await L.redis(["GET", planKey(uid)])); } catch (e) { cur = null; }
  const now = Date.now();
  const rank = { free: 0, standard: 1, premium: 2 };
  let tier = s.tier, from = now;
  if (cur && cur.until > now && cur.tier !== "free") {
    if (rank[cur.tier] === rank[s.tier]) from = cur.until;                                   // same package: add the time on
    else if (rank[cur.tier] > rank[s.tier]) { tier = cur.tier; from = cur.until; }           // cheaper than the current one: extend the current one
    // upgrade: the new package starts now (the rest of the cheaper one is dropped)
  }
  await L.redis(["SET", planKey(uid), JSON.stringify({ tier, until: from + s.days * DAY, src: src || "paid" })]);
}

// owner console: set a package directly (tier "free" ends it)
async function setPlan(uid, tier, days) {
  if (!TIERS[tier]) throw new Error("bad_tier");
  await L.redis(["SET", planKey(uid), JSON.stringify({ tier, until: tier === "free" ? 0 : Date.now() + days * DAY, src: "owner" })]);
}

function publicPlan(plan, extra) {
  const t = TIERS[plan.tier] || TIERS.free;
  return Object.assign({ on: enabled(), tier: plan.tier, name: t.name, until: plan.until, src: plan.src, passes: plan.passes, limits: { trips: t.trips, vans: t.vans, helpers: t.helpers, rounds: t.rounds } }, extra || {});
}

module.exports = { TIERS, SKUS, LEGACY, DAY, enabled, getPlan, limitsFor, openTripCount, usePass, refundPass, grant, setPlan, publicPlan, planKey, passKey };
