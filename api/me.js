// Vercel serverless function: GET /api/me — the signed-in person's own trips (as organizer) and seats (as passenger).
// Index sets: mytrips:<uid> = trip ids, myseats:<uid> = "trip|van|seat". Entries that no longer match are dropped here.
// DELETE /api/me { trips: "delete" | "keep" } — "delete my data": upcoming seats are cancelled, seats on finished trips
// lose the link to the account (the name stays on the organizer's list), my trips are deleted or kept without an owner,
// the account id is removed from those trips' logs, and every session of the account ends.
// GET ?inbox=1 -> { items, unread }   in-app notifications (newest first)
// POST { read: "all" | { t } | { id } } -> marks notifications read (all / one trip / one item)
const L = require("./_lib");
const MAX = 60;

function summary(trip, perVan) {
  const booked = trip.vans.reduce((a, v) => a + (perVan[v.id] || 0), 0);
  return {
    id: trip.id, name: trip.name, organizer: trip.organizer || "", startDate: trip.startDate || "", endDate: trip.endDate || "",
    departTime: trip.departTime || "", meetPoint: trip.meetPoint || "", vans: trip.vans.length, booked, total: trip.vans.length * L.TOTAL_SEATS,
    ended: L.tripEnded(trip),
  };
}

async function deleteAll(req, res, user, dropTrips) {
  const uid = user.id;
  const [tripIds, seatRefs, sids] = await L.pipeline([["SMEMBERS", L.myTripsKey(uid)], ["SMEMBERS", L.mySeatsKey(uid)], ["SMEMBERS", "usess:" + uid]]);
  const refs = (seatRefs || []).map((r) => String(r).split("|")).filter((p) => p.length === 3 && L.tripId(p[0]) && L.parseSeat(p[2]) !== null);
  const ids = Array.from(new Set((tripIds || []).map(String).filter((x) => L.tripId(x)).concat(refs.map((p) => p[0]))));
  const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", L.tripKey(id)])) : [];
  const trips = {};
  ids.forEach((id, i) => { try { if (raws[i]) trips[id] = JSON.parse(raws[i]); } catch (e) { /* skip */ } });
  let cancelled = 0, kept = 0, tripsDeleted = 0, tripsReleased = 0;
  const touched = new Set();

  // seats
  const live = refs.filter((p) => trips[p[0]]);
  const recs = live.length ? await L.pipeline(live.map((p) => ["HGET", L.seatsKey(p[0], p[1]), p[2]])) : [];
  const cmds = [], gone = [];
  live.forEach((p, i) => {
    let rec = null;
    try { rec = JSON.parse(recs[i]); } catch (e) { rec = null; }
    if (!rec || rec.u !== uid) return;
    const key = L.seatsKey(p[0], p[1]);
    if (L.tripEnded(trips[p[0]])) { delete rec.u; cmds.push(["HSET", key, p[2], JSON.stringify(rec)]); kept++; }
    else { cmds.push(["HDEL", key, p[2]]); cancelled++; gone.push([p[0], p[1], Number(p[2]), String(rec.name || "")]); }
    touched.add(p[0]);
  });
  if (cmds.length) await L.pipeline(cmds);
  for (const g of gone) await L.logEvent(g[0], { e: "cancel", v: g[1], s: g[2], n: g[3], by: "account_deleted", at: Date.now() }); // no account id: the organizer sees only the name

  // trips I manage
  for (const id of (tripIds || []).map(String)) {
    const t = trips[id];
    const role = L.roleOf(t, user);
    if (!t || !role) continue;
    if (role === "helper") { // just leave the team
      await L.redis(["SET", L.tripKey(id), JSON.stringify(Object.assign({}, t, { helpers: t.helpers.filter((h) => h.u !== uid) }))]); await L.applyExpiry(t); touched.add(id);
      continue;
    }
    if (!dropTrips && Array.isArray(t.helpers) && t.helpers.length) { // kept trip with helpers: the first helper becomes the owner
      const h = t.helpers[0];
      const next = Object.assign({}, t, { owner: h.u, ownerName: h.n, helpers: t.helpers.slice(1) });
      if (next.invite) { try { await L.redis(["DEL", "inv:" + next.invite.c]); } catch (e) { /* expires anyway */ } delete next.invite; } // the old owner's invite link stops working
      await L.redis(["SET", L.tripKey(id), JSON.stringify(next)]); await L.applyExpiry(next); tripsReleased++; touched.add(id);
      continue;
    }
    if (dropTrips) {
      const bookers = await L.tripBookers(t);
      await L.notify([].concat(...Object.values(bookers), L.teamIds(t)), { k: "trip_deleted", t: id, tn: t.name, by: "owner" }, uid);
      const del = [["DEL", L.tripKey(id)], ["DEL", L.logKey(id)]];
      if (t.invite && t.invite.c) del.push(["DEL", "inv:" + t.invite.c]);
      t.vans.forEach((v) => del.push(["DEL", L.seatsKey(id, v.id)]));
      (t.helpers || []).forEach((h) => del.push(["SREM", L.myTripsKey(h.u), id]));
      await L.pipeline(del); tripsDeleted++; touched.delete(id);
    } else {
      const next = Object.assign({}, t); delete next.owner; delete next.ownerName;
      await L.redis(["SET", L.tripKey(id), JSON.stringify(next)]); await L.applyExpiry(next); tripsReleased++; touched.add(id);
    }
  }

  // remove the account id from the logs of the trips it touched (names and times stay for the organizer)
  for (const id of touched) {
    try {
      const k = L.logKey(id);
      const [list, pttl] = await L.pipeline([["LRANGE", k, "0", "199"], ["PTTL", k]]);
      if (!list || !list.length) continue;
      let changed = false;
      const out = list.map((s) => {
        let ev = null; try { ev = JSON.parse(s); } catch (e) { return s; }
        if (ev && (ev.u === uid || ev.ou === uid)) { if (ev.u === uid) delete ev.u; if (ev.ou === uid) delete ev.ou; changed = true; return JSON.stringify(ev); }
        return s;
      });
      if (!changed) continue;
      const w = [["DEL", k], ["RPUSH", k].concat(out)];
      if (Number(pttl) > 0) w.push(["PEXPIRE", k, String(pttl)]);
      await L.pipeline(w);
    } catch (e) { /* best effort */ }
  }

  // the account itself: indexes and every session
  const end = [["DEL", L.myTripsKey(uid)], ["DEL", L.mySeatsKey(uid)], ["DEL", L.inboxKey(uid)], ["DEL", "usess:" + uid], ["DEL", "sess:" + user.sid]];
  (sids || []).forEach((sid) => { if (/^[a-z0-9]{32}$/.test(String(sid))) end.push(["DEL", "sess:" + sid]); });
  await L.pipeline(end);
  res.setHeader("Set-Cookie", [L.cookieStr(req, "vsb_s", "", 0)]);
  return L.json(res, 200, { ok: true, cancelled, kept, tripsDeleted, tripsReleased });
}

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "POST") { res.setHeader("Allow", "GET, POST, DELETE"); return L.json(res, 405, { error: "method_not_allowed" }); }
  try {
    const user = await L.currentUser(req);
    if (!user) return L.json(res, 401, { error: "login_required" });
    if (req.method === "DELETE") return deleteAll(req, res, user, L.readBody(req).trips === "delete");
    if (req.method === "GET" && req.query && req.query.inbox !== undefined) {
      const rows = (await L.redis(["LRANGE", L.inboxKey(user.id), "0", String(L.INBOX_MAX - 1)])) || [];
      const items = []; rows.forEach((r) => { try { items.push(JSON.parse(r)); } catch (e) { /* skip */ } });
      return L.json(res, 200, { items, unread: items.filter((x) => !x.r).length });
    }
    if (req.method === "POST") {
      const rd = L.readBody(req).read;
      const k = L.inboxKey(user.id);
      const [rows, pttl] = await L.pipeline([["LRANGE", k, "0", String(L.INBOX_MAX - 1)], ["PTTL", k]]);
      let changed = false;
      const out = (rows || []).map((r) => {
        let x = null; try { x = JSON.parse(r); } catch (e) { return r; }
        const hit = rd === "all" || (rd && typeof rd === "object" && ((rd.t && x.t === rd.t) || (rd.id && x.id === rd.id)));
        if (hit && !x.r) { x.r = 1; changed = true; return JSON.stringify(x); }
        return r;
      });
      if (changed) {
        const w = [["DEL", k], ["RPUSH", k].concat(out)];
        w.push(Number(pttl) > 0 ? ["PEXPIRE", k, String(pttl)] : ["EXPIRE", k, String(L.INBOX_DAYS * 86400)]);
        await L.pipeline(w);
      }
      return L.json(res, 200, { ok: true, unread: out.filter((r) => { try { return !JSON.parse(r).r; } catch (e) { return false; } }).length });
    }
    const [tripIds, seatRefs] = await L.pipeline([["SMEMBERS", L.myTripsKey(user.id)], ["SMEMBERS", L.mySeatsKey(user.id)]]);
    const refs = (seatRefs || []).map((r) => String(r).split("|")).filter((p) => p.length === 3 && L.tripId(p[0]) && L.parseSeat(p[2]) !== null).slice(0, MAX);
    const ids = Array.from(new Set((tripIds || []).map(String).filter((x) => L.tripId(x)).slice(0, MAX).concat(refs.map((p) => p[0]))));
    const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", L.tripKey(id)])) : [];
    const trips = {};
    ids.forEach((id, i) => { try { if (raws[i]) trips[id] = JSON.parse(raws[i]); } catch (e) { /* skip */ } });

    // seat counts for my trips + the seat records I booked, in one round trip
    const owned = (tripIds || []).map(String).filter((id) => trips[id] && L.roleOf(trips[id], user)); // owner or helper
    const cmds = [], map = [];
    owned.forEach((id) => trips[id].vans.forEach((v) => { cmds.push(["HLEN", L.seatsKey(id, v.id)]); map.push(["n", id, v.id]); }));
    refs.forEach((p) => { if (trips[p[0]]) { cmds.push(["HGET", L.seatsKey(p[0], p[1]), p[2]]); map.push(["s", p]); } });
    const out = cmds.length ? await L.pipeline(cmds) : [];
    const perVan = {}, mine = {}, stale = [];
    map.forEach((m, i) => {
      if (m[0] === "n") { (perVan[m[1]] = perVan[m[1]] || {})[m[2]] = Number(out[i]) || 0; return; }
      const p = m[1];
      let rec = null;
      try { rec = JSON.parse(out[i]); } catch (e) { rec = null; }
      if (!rec || rec.u !== user.id) { stale.push(p.join("|")); return; }
      (mine[p[0]] = mine[p[0]] || []).push({ v: p[1], s: Number(p[2]), name: String(rec.name || ""), at: rec.at });
    });
    refs.forEach((p) => { if (!trips[p[0]]) stale.push(p.join("|")); });
    const goneTrips = (tripIds || []).map(String).filter((id) => !trips[id] || !L.roleOf(trips[id], user));
    const clean = [];
    if (stale.length) clean.push(["SREM", L.mySeatsKey(user.id)].concat(stale));
    if (goneTrips.length) clean.push(["SREM", L.myTripsKey(user.id)].concat(goneTrips));
    if (clean.length) { try { await L.pipeline(clean); } catch (e) { /* best effort */ } }

    const myTrips = owned.map((id) => Object.assign(summary(trips[id], perVan[id] || {}), { role: L.roleOf(trips[id], user), helpers: (trips[id].helpers || []).length }));
    const mySeats = Object.keys(mine).map((id) => {
      const t = trips[id];
      const list = mine[id].sort((a, b) => a.s - b.s).map((x) => {
        const van = t.vans.find((v) => v.id === x.v);
        return { van: x.v, vanLabel: van ? van.label : x.v, plate: van && van.plate ? van.plate : "", seat: x.s, name: x.name, at: x.at };
      });
      return Object.assign(summary(t, {}), { seats: list });
    });
    const byDate = (a, b) => (a.ended - b.ended) || String(a.startDate || "9").localeCompare(String(b.startDate || "9"));
    myTrips.sort(byDate); mySeats.sort(byDate);
    return L.json(res, 200, { user: L.publicUser(user), trips: myTrips, seats: mySeats });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
