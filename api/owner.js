// Vercel serverless function: /api/owner   (developer/owner console, not for organizers)
//   GET             list every trip with booking counts
//   DELETE ?t=      delete a trip and its bookings
//   GET ?orders=1   payments (newest first) + totals        POST {grant: {t, tier, days} | {t, passes}}  package for a trip's owner
// Needs the OWNER_KEY environment variable (>= 16 chars) and the same value in the x-owner-key header.
// Without OWNER_KEY the endpoint answers 404, as if it did not exist.
const L = require("./_lib");
const P = require("./_plans");

const MAX_BAD = 10;
const MAX_KEYS = 1000;

function ownerKey() {
  const k = process.env.OWNER_KEY;
  return typeof k === "string" && k.length >= 16 ? k : "";
}
function safeEq(x, y) {
  const a = L.crypto.createHash("sha256").update(String(x)).digest();
  const b = L.crypto.createHash("sha256").update(String(y)).digest();
  return L.crypto.timingSafeEqual(a, b);
}
function clientIp(req) {
  return (String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "").split(",")[0].trim() || "unknown").slice(0, 64);
}
const failKey = (req) => "ownerfail:" + clientIp(req) + ":" + Math.floor(Date.now() / 3600000);

async function scanTripKeys() {
  const keys = [];
  let cursor = "0";
  for (let i = 0; i < 30 && keys.length < MAX_KEYS; i++) {
    const r = await L.redis(["SCAN", cursor, "MATCH", "trip:*", "COUNT", "200"]);
    cursor = String(r[0]);
    for (const k of r[1] || []) if (!keys.includes(k)) keys.push(k);
    if (cursor === "0") break;
  }
  return keys.slice(0, MAX_KEYS);
}

async function countKeys(pattern) { // SCAN-based count (capped), e.g. accounts with a live session
  let cursor = "0", n = 0;
  for (let i = 0; i < 30; i++) {
    const r = await L.redis(["SCAN", cursor, "MATCH", pattern, "COUNT", "500"]);
    cursor = String(r[0]); n += (r[1] || []).length;
    if (cursor === "0") break;
  }
  return n;
}

async function loadAllTrips() {
  const keys = await scanTripKeys();
  const raws = keys.length ? await L.redis(["MGET"].concat(keys)) : [];
  const trips = [];
  raws.forEach((raw) => { try { const t = JSON.parse(raw); if (t && t.id && Array.isArray(t.vans)) trips.push(t); } catch (e) { /* skip */ } });
  return trips;
}

module.exports = async function handler(req, res) {
  const key = ownerKey();
  if (!key) return L.json(res, 404, { error: "not_found" });
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  try {
    const fk = failKey(req);
    if (Number(await L.redis(["GET", fk])) >= MAX_BAD) return L.json(res, 429, { error: "too_many" });
    const sent = req.headers && req.headers["x-owner-key"];
    if (typeof sent !== "string" || !sent || sent.length > 200 || !safeEq(sent, key)) {
      await L.pipeline([["INCR", fk], ["EXPIRE", fk, "7200"]]);
      return L.json(res, 403, { error: "bad_key" });
    }

    if (req.method === "GET" && req.query && req.query.orders !== undefined) {
      const ids = ((await L.redis(["LRANGE", "orders:all", "0", "299"])) || []).filter((x) => /^[a-z0-9]{12}$/.test(x));
      const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", "order:" + id])) : [];
      const orders = [];
      let paid = 0, paidN = 0, month = 0;
      const ym = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 7);
      raws.forEach((r) => {
        let o = null; try { o = JSON.parse(r); } catch (e) { o = null; }
        if (!o) return;
        if (o.status === "paid") { paid += o.amount; paidN++; if (new Date((o.paidAt || o.at) + 7 * 3600e3).toISOString().slice(0, 7) === ym) month += o.amount; }
        orders.push({ id: o.id, name: o.name || "", tag: String(o.uid || "").slice(-6), sku: o.sku, label: (P.SKUS[o.sku] || {}).label || o.sku, amount: o.amount, status: o.status, at: o.at, paidAt: o.paidAt || 0, refundReq: o.refundReq || null });
      });
      let watching = false;
      try { const me = await L.currentUser(req); watching = !!me && Number(await L.redis(["SISMEMBER", "owner:watch", me.id])) === 1; } catch (e) { watching = false; }
      return L.json(res, 200, { orders, watching, totals: { paid, paidN, month }, on: P.enabled(), stripe: /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || ""), mode: /^sk_live_/.test(process.env.STRIPE_SECRET_KEY || "") ? "live" : "test" });
    }
    if (req.method === "POST") {
      const bd = L.readBody(req) || {};
      if (bd.watch !== undefined) { // this account (logged in with LINE in this browser) gets a bell notice for every refund request
        const me = await L.currentUser(req);
        if (!me) return L.json(res, 401, { error: "login_required" });
        await L.redis([bd.watch ? "SADD" : "SREM", "owner:watch", me.id]);
        return L.json(res, 200, { ok: true, watching: !!bd.watch });
      }
      const g = bd.grant || {};
      const t = L.tripId(g.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip || !trip.owner) return L.json(res, 404, { error: "no_trip" });
      if (g.tester !== undefined) { // packages on for this account only (before PLANS_ON=1)
        await L.redis([g.tester ? "SADD" : "SREM", P.TESTERS, trip.owner]);
      } else if (g.passes !== undefined) {
        const n = Number(g.passes);
        if (!Number.isInteger(n) || n < 1 || n > 50) return L.json(res, 400, { error: "bad_passes" });
        await L.redis(["INCRBY", P.passKey(trip.owner), String(n)]);
      } else {
        const days = Number(g.days);
        if (!P.TIERS[g.tier] || (g.tier !== "free" && (!Number.isInteger(days) || days < 1 || days > 3660))) return L.json(res, 400, { error: "bad_grant" });
        await P.setPlan(trip.owner, g.tier, days);
      }
      const plan = await P.getPlan(trip.owner);
      return L.json(res, 200, { ok: true, owner: trip.ownerName || "", plan: P.publicPlan(plan), tester: plan.on });
    }

    if (req.method === "GET") {
      if (req.query && req.query.log) {
        const t = L.tripId(req.query.log);
        if (!t) return L.json(res, 400, { error: "bad_trip" });
        const rows = (await L.redis(["LRANGE", L.logKey(t), "0", "199"])) || [];
        const events = [];
        rows.forEach((r) => { try { events.push(JSON.parse(r)); } catch (e) { /* skip */ } });
        return L.json(res, 200, { events });
      }
      const trips = await loadAllTrips();
      const cmds = [];
      trips.forEach((t) => t.vans.forEach((v) => cmds.push(["HLEN", L.seatsKey(t.id, v.id)])));
      const counts = cmds.length ? await L.pipeline(cmds) : [];
      const ttls = trips.length ? await L.pipeline(trips.map((t) => ["PTTL", L.tripKey(t.id)])) : [];
      let ci = 0;
      const out = trips.map((t, ti) => {
        const vans = t.vans.map((v) => ({ id: v.id, label: v.label, n: Number(counts[ci++]) || 0 }));
        return {
          id: t.id, name: t.name || "", organizer: t.organizer || "", startDate: t.startDate || "", endDate: t.endDate || "",
          departTime: t.departTime || "", createdAt: t.createdAt || 0, expiresAt: Number(ttls[ti]) > 0 ? Date.now() + Number(ttls[ti]) : 0, plannedExpiresAt: (L.expireAtFor(t) || 0) * 1000, updatedAt: t.updatedAt || t.createdAt || 0, ended: L.tripEnded(t),
          vans, booked: vans.reduce((a, v) => a + v.n, 0), total: vans.length * L.TOTAL_SEATS,
          ownerName: t.ownerName || "", hasOwner: !!t.owner, ownerTag: t.owner ? String(t.owner).slice(-6) : "", helpers: (t.helpers || []).map((h) => ({ name: h.n || "", tag: String(h.u || "").slice(-6) })),
          maxPerPerson: L.maxPerPerson(t), invite: !!(t.invite && t.invite.exp > Date.now()),
        };
      }).sort((a, b) => b.createdAt - a.createdAt);
      const owners = new Set(trips.filter((t) => t.owner).map((t) => t.owner));
      const helpersN = trips.reduce((a, t) => a + ((t.helpers || []).length), 0);
      const stats = { accounts: await countKeys("usess:*"), owners: owners.size, helpers: helpersN };
      return L.json(res, 200, { trips: out, retentionDays: L.RETENTION_DAYS, stats });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      if (!t) return L.json(res, 400, { error: "bad_trip" });
      const trip = await L.loadTrip(t);
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      const cmds = [["DEL", L.tripKey(t)], ["DEL", L.logKey(t)]];
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
