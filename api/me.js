// Vercel serverless function: GET /api/me — the signed-in person's own trips (as organizer) and seats (as passenger).
// Index sets: mytrips:<uid> = trip ids, myseats:<uid> = "trip|van|seat". Entries that no longer match are dropped here.
// DELETE /api/me { trips: "delete" | "keep" } — "delete my data": upcoming seats are cancelled, seats on finished trips
// lose the link to the account (the name stays on the organizer's list), my trips are deleted or kept without an owner,
// the account id is removed from those trips' logs, and every session of the account ends.
// GET ?inbox=1 -> { items, unread }   in-app notifications (newest first)
// GET ?prefs=1 -> { off: [kinds] }   POST { prefs: { off: [kinds] } }   which LINE messages the person switched off
// POST { read: "all" | { t } | { id } } -> marks notifications read (all / one trip / one item)
const L = require("./_lib");
const P = require("./_plans");
const Q = require("./_queue");
const MAX = 60;
const SAVED_MAX = 30, RECENT_MAX = 5;

function summary(trip, perVan) {
  const booked = trip.vans.reduce((a, v) => a + (perVan[v.id] || 0), 0);
  return {
    id: trip.id, name: trip.name, organizer: trip.organizer || "", startDate: trip.startDate || "", endDate: trip.endDate || "",
    departTime: trip.departTime || "", returnTime: trip.returnTime || "", meetPoint: trip.meetPoint || "", tripDays: L.tripDaysText(trip.tripN, trip.tripStart), tripStart: trip.tripStart || "", vans: trip.vans.length, booked, total: trip.vans.length * L.TOTAL_SEATS,
    ended: L.tripEnded(trip), closed: L.bookingClosed(trip), closeAt: trip.closeAt || "", qf: /^(1|true|on)$/i.test(String(process.env.PAYMENT_QUEUE || "")) || undefined, staffSeat: !!trip.staffSeat, limit: L.maxPerPerson(trip),
  };
}

// newest first, with r = 1 for the ones already read
async function inbox(uid) {
  const [rows, readIds, allAt] = await L.pipeline([["LRANGE", L.inboxKey(uid), "0", String(L.INBOX_MAX - 1)], ["SMEMBERS", L.inboxReadKey(uid)], ["GET", L.inboxAllKey(uid)]]);
  const seen = new Set(readIds || []), upto = Number(allAt) || 0, items = [];
  (rows || []).forEach((r) => { try { const x = JSON.parse(r); if (x.at <= upto || seen.has(x.id)) x.r = 1; else delete x.r; items.push(x); } catch (e) { /* skip */ } });
  return items;
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
    if (L.tripEnded(trips[p[0]])) { delete rec.u; delete rec.ln; delete rec.lp; cmds.push(["HSET", key, p[2], JSON.stringify(rec)]); kept++; }
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
      const list = await L.redis(["LRANGE", k, "0", "999"]);
      if (!list || !list.length) continue;
      let changed = false;
      const out = list.map((s) => {
        let ev = null; try { ev = JSON.parse(s); } catch (e) { return s; }
        if (ev && (ev.u === uid || ev.ou === uid)) { if (ev.u === uid) delete ev.u; if (ev.ou === uid) delete ev.ou; changed = true; return JSON.stringify(ev); }
        return s;
      });
      if (!changed) continue;
      // edit in place, counting from the tail: new events are pushed at the head, so tail positions stay put;
      // each entry is only replaced if it still holds the value read above
      const n = list.length;
      for (let i = 0; i < n; i++) {
        if (out[i] === list[i]) continue;
        const idx = String(i - n);
        if ((await L.redis(["LINDEX", k, idx])) === list[i]) await L.redis(["LSET", k, idx, out[i]]);
      }
    } catch (e) { /* best effort */ }
  }

  // account activity log: this account's own list goes, and its id is taken off the shared list (the events stay, without a person)
  try {
    await L.redis(["DEL", "audit:u:" + uid]); await L.redis(["DEL", L.pushOffKey(uid)]);
    const list = (await L.redis(["LRANGE", "audit:all", "0", "19999"])) || [], n = list.length;
    for (let i = 0; i < n; i++) {
      let ev = null; try { ev = JSON.parse(list[i]); } catch (e) { continue; }
      if (!ev || ev.u !== uid) continue;
      delete ev.u; // counted from the tail: new events are pushed at the head, so tail positions stay put
      const idx = String(i - n);
      if ((await L.redis(["LINDEX", "audit:all", idx])) === list[i]) await L.redis(["LSET", "audit:all", idx, JSON.stringify(ev)]);
    }
  } catch (e) { /* best effort */ }

  // the account itself: indexes and every session
  const end = [["DEL", L.myTripsKey(uid)], ["DEL", L.mySeatsKey(uid)], ["DEL", L.myQueueKey(uid)], ["DEL", L.mySavedKey(uid)], ["DEL", L.inboxKey(uid)], ["DEL", L.inboxReadKey(uid)], ["DEL", L.inboxAllKey(uid)], ["DEL", L.inboxVerKey(uid)], ["DEL", "usess:" + uid], ["DEL", "sess:" + user.sid]];
  (sids || []).forEach((sid) => { if (/^[a-z0-9]{32}$/.test(String(sid))) end.push(["DEL", "sess:" + sid]); });
  await L.pipeline(end);
  res.setHeader("Set-Cookie", [L.cookieStr(req, "vsb_s", "", 0)]);
  return L.json(res, 200, { ok: true, cancelled, kept, tripsDeleted, tripsReleased });
}

module.exports = async function handler(req, res) {
  if (L.tooBig(req)) return L.json(res, 413, { error: "too_big" });
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "POST") { res.setHeader("Allow", "GET, POST, DELETE"); return L.json(res, 405, { error: "method_not_allowed" }); }
  if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
  try {
    const user = await L.currentUser(req);
    if (!user) return L.json(res, 401, { error: "login_required" });
    if (req.method === "DELETE") return deleteAll(req, res, user, L.readBody(req).trips === "delete");
    if (req.method === "GET" && req.query && req.query.saved !== undefined) {
      const ids = ((await L.redis(["SMEMBERS", L.mySavedKey(user.id)])) || []).map(String).filter((x) => L.tripId(x));
      return L.json(res, 200, { ids });
    }
    if (req.method === "POST" && L.readBody(req).save !== undefined) { // star / un-star a trip: { save: <trip id>, on: true|false }
      const b = L.readBody(req), id = L.tripId(String(b.save || "").toLowerCase());
      if (!id) return L.json(res, 400, { error: "bad_trip" });
      if (b.on === false) { await L.redis(["SREM", L.mySavedKey(user.id), id]); return L.json(res, 200, { ok: true, saved: false }); }
      const cur = ((await L.redis(["SMEMBERS", L.mySavedKey(user.id)])) || []).map(String), n = cur.length, has = cur.includes(id); // at most 30, cheap to read whole
      if (!has && n >= SAVED_MAX) return L.json(res, 400, { error: "saved_full", max: SAVED_MAX });
      if (!(await L.loadTrip(id))) return L.json(res, 404, { error: "no_trip" });
      await L.pipeline([["SADD", L.mySavedKey(user.id), id], ["EXPIRE", L.mySavedKey(user.id), String(L.MY_DAYS * 86400)]]);
      return L.json(res, 200, { ok: true, saved: true });
    }
    if (req.method === "GET" && req.query && req.query.inbox !== undefined) {
      const items = await inbox(user.id);
      return L.json(res, 200, { items, unread: items.filter((x) => !x.r).length });
    }
    if (req.method === "GET" && req.query && req.query.prefs !== undefined) {
      let off = []; try { off = JSON.parse((await L.redis(["GET", L.pushOffKey(user.id)])) || "[]"); } catch (e) { /* none */ }
      return L.json(res, 200, { off: off.filter((x) => L.PUSH_KINDS.includes(x)) });
    }
    if (req.method === "POST" && L.readBody(req).prefs) {
      const off = Array.from(new Set((Array.isArray(L.readBody(req).prefs.off) ? L.readBody(req).prefs.off : []).filter((x) => L.PUSH_KINDS.includes(x))));
      if (off.length) await L.redis(["SET", L.pushOffKey(user.id), JSON.stringify(off)]); else await L.redis(["DEL", L.pushOffKey(user.id)]);
      return L.json(res, 200, { ok: true, off });
    }
    if (req.method === "POST") {
      const rd = L.readBody(req).read, uid = user.id, ttl = String(L.INBOX_DAYS * 86400);
      if (rd === "all") await L.pipeline([["SET", L.inboxAllKey(uid), String(Date.now()), "EX", ttl], ["DEL", L.inboxReadKey(uid)]]);
      else if (rd && typeof rd === "object") {
        const ids = (await inbox(uid)).filter((x) => !x.r && ((rd.t && x.t === rd.t) || (rd.id && x.id === rd.id))).map((x) => x.id);
        if (ids.length) await L.pipeline([["SADD", L.inboxReadKey(uid)].concat(ids), ["EXPIRE", L.inboxReadKey(uid), ttl]]);
      }
      const items = await inbox(uid);
      return L.json(res, 200, { ok: true, unread: items.filter((x) => !x.r).length });
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

    const myTrips = owned.map((id) => Object.assign(summary(trips[id], perVan[id] || {}), { role: L.roleOf(trips[id], user), helpers: (trips[id].helpers || []).length, plus: !!trips[id].plus }));
    const mySeats = Object.keys(mine).map((id) => {
      const t = trips[id];
      const list = mine[id].sort((a, b) => a.s - b.s).map((x) => {
        const van = t.vans.find((v) => v.id === x.v);
        return { van: x.v, vanLabel: van ? van.label : x.v, plate: van && van.plate ? van.plate : "", seat: x.s, name: x.name, at: x.at, vk: van && t.vans.length > 1 ? van.k : undefined }; // vk: the passenger's own van link (a trip with several vans has no open trip-wide link)
      });
      return Object.assign(summary(t, {}), { seats: list });
    });
    const byDate = (a, b) => (a.ended - b.ended) || String(a.startDate || "9").localeCompare(String(b.startDate || "9"));
    myTrips.sort(byDate); mySeats.sort(byDate);
    // trips where I am waiting in the booking queue (claimed a name, turn not over): shown above my seats
    let queues = [];
    try {
      // entries are "<trip>" (the trip's first van) or "<trip>|<van id>"
      const qents = ((await L.redis(["SMEMBERS", L.myQueueKey(user.id)])) || []).map(String).map((x) => { const k = x.indexOf("|"); return { raw: x, id: k < 0 ? x : x.slice(0, k), v: k < 0 ? "" : x.slice(k + 1) }; }).filter((x) => L.tripId(x.id)).slice(0, MAX);
      const qids = qents.map((x) => x.id);
      if (qids.length && Q.flagOn()) {
        const need = Array.from(new Set(qids.filter((id) => !trips[id])));
        const rawT = need.length ? await L.pipeline(need.map((id) => ["GET", L.tripKey(id)])) : [];
        need.forEach((id, i) => { try { if (rawT[i]) trips[id] = JSON.parse(rawT[i]); } catch (e) { /* skip */ } });
        const rawQ = await L.pipeline(qents.map((e) => ["HGET", Q.qKey(e.id), trips[e.id] ? Q.field(trips[e.id], e.v) : "q"]));
        const drop = [];
        qents.forEach((e, i) => {
          const id = e.id;
          let q = null; try { q = JSON.parse(rawQ[i]); } catch (err) { q = null; }
          const tr = trips[id];
          if (!tr || L.tripEnded(tr) || !q || !Array.isArray(q.items)) { drop.push(e.raw); return; }
          const st = Q.stateOf(q, user);
          if (!q.on || (st.s !== "wait" && st.s !== "turn")) { if (st.s === "out" || st.s === "done") drop.push(e.raw); return; }
          const mineRow = q.items.find((i) => i.u === user.id), hd = Q.turnOf(q);
          queues.push(Object.assign(summary(tr, {}), { qv: Q.vanOf(tr, e.v).id, qvl: tr.vans.length > 1 ? Q.vanOf(tr, e.v).label : undefined, qk: tr.vans.length > 1 ? Q.vanOf(tr, e.v).k : undefined, qs: st.s, ahead: st.ahead || 0, ok: st.s === "turn" ? true : !!st.ok, qpos: q.items.indexOf(mineRow) + 1, qturn: hd ? q.items.indexOf(hd) + 1 : 0 }));
        });
        if (drop.length) { try { await L.redis(["SREM", L.myQueueKey(user.id)].concat(drop)); } catch (e) { /* best effort */ } }
        queues.sort((a, b) => (a.qs === "turn" ? 0 : 1) - (b.qs === "turn" ? 0 : 1) || String(a.startDate || "9").localeCompare(String(b.startDate || "9")));
      }
    } catch (e) { queues = []; }
    // starred trips + the few trips this device opened last (?recent=a,b,c): small cards in "my seats"
    let saved = [], recent = [];
    try {
      const savedIds = ((await L.redis(["SMEMBERS", L.mySavedKey(user.id)])) || []).map(String).filter((x) => L.tripId(x)).slice(0, SAVED_MAX);
      const recentIds = Array.from(new Set(String((req.query && req.query.recent) || "").toLowerCase().split(",").filter((x) => L.tripId(x)))).slice(0, RECENT_MAX);
      const all = Array.from(new Set(savedIds.concat(recentIds)));
      const need = all.filter((id) => !trips[id]);
      const rawT = need.length ? await L.pipeline(need.map((id) => ["GET", L.tripKey(id)])) : [];
      need.forEach((id, i) => { try { if (rawT[i]) trips[id] = JSON.parse(rawT[i]); } catch (e) { /* skip */ } });
      const live = all.filter((id) => trips[id] && !L.tripEnded(trips[id]));
      const cmds2 = [], map2 = [];
      live.forEach((id) => trips[id].vans.forEach((v) => { cmds2.push(["HLEN", L.seatsKey(id, v.id)]); map2.push([id, v.id]); }));
      const out2 = cmds2.length ? await L.pipeline(cmds2) : [];
      const pv = {}; map2.forEach((m, i) => { (pv[m[0]] = pv[m[0]] || {})[m[1]] = Number(out2[i]) || 0; });
      saved = savedIds.filter((id) => live.includes(id)).map((id) => summary(trips[id], pv[id] || {}));
      const stale = savedIds.filter((id) => !live.includes(id));
      if (stale.length) { try { await L.redis(["SREM", L.mySavedKey(user.id)].concat(stale)); } catch (e) { /* best effort */ } }
      recent = recentIds.filter((id) => live.includes(id) && !savedIds.includes(id)).map((id) => summary(trips[id], pv[id] || {}));
    } catch (e) { saved = []; recent = []; }
    let plan = null;
    {
      try {
        const p = await P.getPlan(user.id);
        if (!p.on) throw new Error("off");
        plan = P.publicPlan(p, { used: await P.monthUsed(user.id) });
        // a few days before a package runs out: one reminder in the bell (PromptPay can't renew by itself)
        if (p.tier !== "free" && p.until - Date.now() < 3 * P.DAY) {
          const first = await L.redis(["SET", "planrem:" + user.id + ":" + p.until, "1", "NX", "EX", String(10 * 86400)]);
          if (first === "OK") await L.notify([user.id], { k: "plan_expiring", tn: (P.TIERS[p.tier] || {}).name || "", until: p.until, amt: (P.priceOf(p.tier === "premium" ? "pre_m" : "std_m") || {}).amount });
        }
      } catch (e) { plan = null; }
    }
    return L.json(res, 200, { user: L.publicUser(user), trips: myTrips, seats: mySeats, queues, saved, recent, plan });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
