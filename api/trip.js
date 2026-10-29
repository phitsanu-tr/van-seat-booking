// Vercel serverless function: /api/trip — every trip belongs to the signed-in LINE account that created it (trip.owner)
//   POST                 create a trip (signed in)        -> { id, trip }
//   GET  ?t= [&roster=1] read a trip for editing (owner)   -> { trip, booked, perVan, roster? }
//   PUT                  update a trip (owner, body has t)
//   DELETE ?t=           delete a trip and its bookings (owner)
const L = require("./_lib");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_VANS = 5;           // vans per trip (a trip created earlier with more keeps its count when edited)
const TRIPS_PER_MONTH = 30; // per LINE account, calendar month in Thai time (UTC+7)

// Counts a creation against this month's quota for the account. Returns the error code when over the limit.
async function takeQuota(user) {
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const key = "quota:" + month + ":u:" + user.id;
  const out = await L.pipeline([["INCR", key], ["EXPIRE", key, String(40 * 86400)]]);
  if (Number(out[0]) > TRIPS_PER_MONTH) { try { await L.redis(["DECR", key]); } catch (e) { /* best effort */ } return "quota_month"; }
  return null;
}
async function refundQuota(user) {
  if (!user) return;
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  try { await L.redis(["DECR", "quota:" + month + ":u:" + user.id]); } catch (e) { /* best effort */ }
}

function clean(body, vanCap) {
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const name = s(body.name, 80);
  if (!name) return { error: "bad_name" };
  const startDate = s(body.startDate, 10), endDate = s(body.endDate, 10), departTime = s(body.departTime, 5);
  if (startDate && !DATE_RE.test(startDate)) return { error: "bad_date" };
  if (endDate && !DATE_RE.test(endDate)) return { error: "bad_date" };
  if (departTime && !TIME_RE.test(departTime)) return { error: "bad_time" };
  const vans = Array.isArray(body.vans) ? body.vans : [];
  if (vans.length < 1 || vans.length > Math.max(MAX_VANS, vanCap || 0)) return { error: "bad_vans" };
  const seen = new Set();
  const outVans = [];
  for (const v of vans) {
    const label = s(v && v.label, 12);
    if (!label) return { error: "bad_vans" };
    const id = s(v && v.id, 12);
    if (id && (seen.has(id) || !/^[A-Za-z0-9]+$/.test(id))) return { error: "bad_vans" };
    if (id) seen.add(id);
    const plate = s(v && v.plate, 25);
    outVans.push(plate ? { id, label, plate } : { id, label });
  }
  const value = { name, organizer: s(body.organizer, 80), startDate, endDate, departTime, meetPoint: s(body.meetPoint, 120), vans: outVans };
  if (body.maxPerPerson !== undefined && body.maxPerPerson !== null && body.maxPerPerson !== "") {
    const m = Number(body.maxPerPerson);
    if (!Number.isInteger(m) || m < 0 || m > 50) return { error: "bad_max" };
    value.maxPerPerson = m; // 0 = no limit
  }
  return { value };
}

// Gives each new van an id that is unused so far (v1, v2, ...).
function assignVanIds(vans, taken) {
  const used = new Set(taken);
  vans.forEach((v) => { if (v.id) used.add(v.id); });
  let i = 1;
  vans.forEach((v) => {
    if (v.id) return;
    while (used.has("v" + i)) i++;
    v.id = "v" + i; used.add(v.id);
  });
  return vans;
}

// Only the owner's account may read the edit view, change or delete a trip.
function isOwner(trip, user) { return !!(user && trip.owner && trip.owner === user.id); }
function deny(res, user) { return user ? L.json(res, 403, { error: "not_owner" }) : L.json(res, 401, { error: "login_required" }); }
function tripSummary(trip, user) { return Object.assign(L.publicTrip(trip), { mine: !!(user && trip.owner === user.id) }); }

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  try {
    const user = await L.currentUser(req);
    if (req.method === "POST") {
      if (!user) return L.json(res, 401, { error: "login_required" }); // a trip always has an owner account
      const c = clean(L.readBody(req));
      if (c.error) return L.json(res, 400, { error: c.error });
      const over = await takeQuota(user);
      if (over) return L.json(res, 429, { error: over, limit: TRIPS_PER_MONTH });
      const id = L.newId(8);
      const now = Date.now();
      const trip = Object.assign({ id, schemaVersion: 1, createdAt: now, updatedAt: now, owner: user.id, ownerName: user.name }, c.value);
      trip.vans = assignVanIds(trip.vans, []);
      const ok = await L.redis(["SET", L.tripKey(id), JSON.stringify(trip), "NX"]);
      if (ok !== "OK") { await refundQuota(user); return L.json(res, 502, { error: "storage_error" }); }
      await L.applyExpiry(trip);
      { try { await L.pipeline([["SADD", L.myTripsKey(user.id), id], ["EXPIRE", L.myTripsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort */ } }
      return L.json(res, 200, { id, trip: tripSummary(trip, user) });
    }

    if (req.method === "GET") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return deny(res, user);
      const counts = await L.pipeline(trip.vans.map((v) => ["HLEN", L.seatsKey(t, v.id)]));
      const perVan = {};
      trip.vans.forEach((v, i) => { perVan[v.id] = Number(counts[i]) || 0; });
      const booked = counts.reduce((a, n) => a + (Number(n) || 0), 0);
      let roster;
      if (req.query.roster !== undefined) { // organizer's passenger list: every seat of every van (no account ids)
        const all = await L.pipeline(trip.vans.map((v) => ["HGETALL", L.seatsKey(t, v.id)]));
        roster = {};
        trip.vans.forEach((v, i) => {
          const flat = all[i] || [], seats = {};
          for (let j = 0; j + 1 < flat.length; j += 2) {
            const n = L.parseSeat(flat[j]); if (n === null) continue;
            try { const r = JSON.parse(flat[j + 1]); if (r && r.name) seats[n] = Object.assign({ name: String(r.name), at: r.at }, r.u ? { a: 1 } : {}, user && r.u === user.id ? { m: 1 } : {}); } catch (e) { /* skip */ }
          }
          roster[v.id] = seats;
        });
      }
      return L.json(res, 200, { trip: tripSummary(trip, user), booked, perVan, roster, ended: L.tripEnded(trip) });
    }

    if (req.method === "DELETE") {
      const t = L.tripId(req.query && req.query.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return deny(res, user);
      const cmds = [["DEL", L.tripKey(t)], ["DEL", L.logKey(t)]];
      if (trip.owner) cmds.push(["SREM", L.myTripsKey(trip.owner), t]);
      trip.vans.forEach((v) => cmds.push(["DEL", L.seatsKey(t, v.id)]));
      await L.pipeline(cmds);
      return L.json(res, 200, { ok: true });
    }

    if (req.method === "PUT") {
      const body = L.readBody(req);
      const t = L.tripId(body.t);
      const trip = t ? await L.loadTrip(t) : null;
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      if (!isOwner(trip, user)) return deny(res, user);
      const c = clean(body, trip.vans.length);
      if (c.error) return L.json(res, 400, { error: c.error });
      const oldIds = trip.vans.map((v) => v.id);
      const next = assignVanIds(c.value.vans.map((v) => ({ id: oldIds.includes(v.id) ? v.id : "", label: v.label, plate: v.plate })), oldIds);
      const kept = new Set(next.map((v) => v.id));
      const removed = oldIds.filter((id) => !kept.has(id));
      const updated = Object.assign({}, trip, c.value, { vans: next, schemaVersion: 1, updatedAt: Date.now() });
      const cmds = [["SET", L.tripKey(t), JSON.stringify(updated)]];
      removed.forEach((id) => cmds.push(["DEL", L.seatsKey(t, id)]));
      await L.pipeline(cmds);
      await L.applyExpiry(updated); // SET cleared the TTL; dates may have changed
      return L.json(res, 200, { ok: true, trip: tripSummary(updated, user) });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
