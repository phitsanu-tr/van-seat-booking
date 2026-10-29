// Vercel serverless function: GET / POST / DELETE /api/seats
// Query / body: t = trip code (default "default"), v = van id (default: the trip's first van).
// Storage: one Redis hash per van (field = seat number, value = JSON {name, at}).
const L = require("./_lib");

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });

  try {
    const body = req.method === "GET" ? {} : L.readBody(req);
    const t = L.tripId((req.query && req.query.t) || body.t);
    if (!t) return L.json(res, 404, { error: "no_trip" });
    const trip = await L.loadTrip(t);
    if (!trip) return L.json(res, 404, { error: "no_trip" });
    const wanted = String((req.query && req.query.v) || body.v || trip.vans[0].id);
    const van = trip.vans.find((x) => x.id === wanted);
    if (!van) return L.json(res, 404, { error: "no_van" });
    const key = L.seatsKey(t, van.id);
    const user = await L.currentUser(req);
    const isOwner = !!(user && trip.owner && trip.owner === user.id);

    if (req.method === "GET") {
      const cmds = [["HGETALL", key]].concat(trip.vans.map((x) => ["HLEN", L.seatsKey(t, x.id)]));
      const out = await L.pipeline(cmds);
      const flat = out[0] || [];
      const seats = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const n = L.parseSeat(flat[i]);
        if (n === null) continue;
        try {
          const v = JSON.parse(flat[i + 1]);
          // m = booked by the signed-in visitor, a = booked by someone signed in (only they or the organizer can cancel it)
          if (v && v.name) seats[n] = Object.assign({ name: String(v.name), at: v.at }, v.u ? { a: 1 } : {}, v.u && user && v.u === user.id ? { m: 1 } : {});
        } catch (e) { /* skip a damaged entry */ }
      }
      const counts = {};
      trip.vans.forEach((x, i) => { counts[x.id] = Number(out[i + 1]) || 0; });
      return L.json(res, 200, { trip: L.publicTrip(trip), van: van.id, seats, counts, ended: L.tripEnded(trip), me: L.publicUser(user), owner: isOwner, needLogin: L.REQUIRE_LOGIN, limit: L.maxPerPerson(trip) });
    }

    if ((req.method === "POST" || req.method === "DELETE") && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    if ((req.method === "POST" || req.method === "DELETE" || req.method === "PATCH") && await L.rateLimited(req, user, "seat:" + t, 30, 600)) return L.json(res, 429, { error: "too_many" });
    if ((req.method === "PATCH" || (req.method === "POST" && body.move)) && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    if (req.method === "PATCH") {
      // rename a seat: the person who booked it, or the organizer. The booking time stays (it identifies the booking).
      if (!user) return L.json(res, 401, { error: "login_required" });
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      const rawName = String(body.name || "");
      const name = L.cleanName(rawName).text;
      if (!rawName.trim()) return L.json(res, 400, { error: "bad_name" });
      if (name !== rawName || !L.hasBaseLetter(name)) return L.json(res, 400, { error: "name_chars" });
      const raw = await L.redis(["HGET", key, String(seat)]);
      let rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (!rec) return L.json(res, 404, { error: "no_seat" });
      if (!(rec.u ? rec.u === user.id || isOwner : isOwner)) return L.json(res, 403, { error: "not_yours" });
      const old = rec.name; rec.name = name;
      await L.redis(["HSET", key, String(seat), JSON.stringify(rec)]);
      await L.logEvent(t, { e: "rename", v: van.id, s: seat, n: name, on: old, u: user.id, by: isOwner && rec.u !== user.id ? "owner" : undefined, at: Date.now() });
      return L.json(res, 200, { ok: true, name, at: rec.at });
    }

    if (req.method === "POST" && body.move) {
      // organizer moves a passenger to another seat / van; an occupied target swaps the two seats
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (!isOwner) return L.json(res, 403, { error: "not_owner" });
      const m = body.move || {};
      const fromVan = trip.vans.find((x) => x.id === String(m.fromVan || "")), toVan = trip.vans.find((x) => x.id === String(m.toVan || ""));
      const fs = L.parseSeat(m.fromSeat), ts = L.parseSeat(m.toSeat);
      if (!fromVan || !toVan || fs === null || ts === null) return L.json(res, 400, { error: "bad_seat" });
      if (fromVan.id === toVan.id && fs === ts) return L.json(res, 200, { ok: true });
      const fk = L.seatsKey(t, fromVan.id), tk = L.seatsKey(t, toVan.id);
      const [fr, tr] = await L.pipeline([["HGET", fk, String(fs)], ["HGET", tk, String(ts)]]);
      let a = null, b = null; try { a = JSON.parse(fr); } catch (e) { a = null; } try { b = JSON.parse(tr); } catch (e) { b = null; }
      if (!a) return L.json(res, 404, { error: "no_seat" });
      if (b && m.swap !== true) return L.json(res, 409, { error: "taken" });
      const ref = (v, s) => t + "|" + v + "|" + s;
      const cmds = [["HSET", tk, String(ts), JSON.stringify(a)]];
      if (b) cmds.push(["HSET", fk, String(fs), JSON.stringify(b)]); else cmds.push(["HDEL", fk, String(fs)]);
      if (a.u) cmds.push(["SREM", L.mySeatsKey(a.u), ref(fromVan.id, fs)], ["SADD", L.mySeatsKey(a.u), ref(toVan.id, ts)]);
      if (b && b.u) cmds.push(["SREM", L.mySeatsKey(b.u), ref(toVan.id, ts)], ["SADD", L.mySeatsKey(b.u), ref(fromVan.id, fs)]);
      if (!b) { // HSETNX-style guard: the target must still be empty (someone may have booked it meanwhile)
        const ok = await L.redis(["HSETNX", tk, String(ts), JSON.stringify(a)]);
        if (ok !== 1) return L.json(res, 409, { error: "taken" });
        cmds.shift();
      }
      await L.pipeline(cmds);
      const exp = L.expireAtFor(trip);
      if (exp && exp > Math.floor(Date.now() / 1000)) { try { await L.redis(["EXPIREAT", tk, String(exp)]); } catch (e) { /* best effort */ } }
      await L.logEvent(t, { e: b ? "swap" : "move", v: fromVan.id, s: fs, tv: toVan.id, ts, n: a.name, n2: b ? b.name : undefined, u: user.id, by: "owner", at: Date.now() });
      return L.json(res, 200, { ok: true, swapped: !!b });
    }

    if (req.method === "POST") {
      if (L.REQUIRE_LOGIN && !user) return L.json(res, 401, { error: "login_required" });
      const seat = L.parseSeat(body.seat);
      const rawName = String(body.name || "");
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!rawName.trim()) return L.json(res, 400, { error: "bad_name" });
      const name = L.cleanName(rawName).text;
      if (name !== rawName || !L.hasBaseLetter(name)) return L.json(res, 400, { error: "name_chars" });
      const limit = L.maxPerPerson(trip);
      if (user && !isOwner && limit > 0) { // count this account's seats in every van of the trip
        const all = await L.pipeline(trip.vans.map((x) => ["HGETALL", L.seatsKey(t, x.id)]));
        let mineN = 0;
        all.forEach((flat) => { for (let i = 1; i < (flat || []).length; i += 2) { try { if (JSON.parse(flat[i]).u === user.id) mineN++; } catch (e) { /* skip */ } } });
        if (mineN >= limit) return L.json(res, 403, { error: "seat_limit", limit });
      }
      const at = Date.now();
      // HSETNX only writes when the seat is still empty, so two people can never take the same seat.
      const rec = { name, at };
      if (user) rec.u = user.id;
      const created = await L.redis(["HSETNX", key, String(seat), JSON.stringify(rec)]);
      if (created !== 1) return L.json(res, 409, { error: "taken" });
      if (user) { try { await L.pipeline([["SADD", L.mySeatsKey(user.id), t + "|" + van.id + "|" + seat], ["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* the seat is booked; the index is best effort */ } }
      const exp = L.expireAtFor(trip);
      const live = exp && exp > Math.floor(Date.now() / 1000);
      if (live) { try { await L.redis(["EXPIREAT", key, String(exp)]); } catch (e) { /* best effort */ } } // a new van hash has no TTL yet
      await L.logEvent(t, { e: "book", v: van.id, s: seat, n: name, u: user ? user.id : undefined, at }, live ? exp : undefined);
      return L.json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (L.REQUIRE_LOGIN && !user) return L.json(res, 401, { error: "login_required" });
      const raw = await L.redis(["HGET", key, String(seat)]);
      if (raw === null) return L.json(res, 200, { ok: true });
      let prev = {};
      try { prev = JSON.parse(raw) || {}; } catch (e) { /* damaged entry */ }
      // Only the person who booked the seat, or the trip's organizer, can cancel it.
      if (!(user && ((prev.u && user.id === prev.u) || isOwner))) return L.json(res, user ? 403 : 401, { error: user ? "not_yours" : "login_required" });
      const removed = await L.redis(["HDEL", key, String(seat)]);
      if (Number(removed) === 1) {
        if (prev.u) { try { await L.redis(["SREM", L.mySeatsKey(prev.u), t + "|" + van.id + "|" + seat]); } catch (e) { /* best effort */ } }
        await L.logEvent(t, { e: "cancel", v: van.id, s: seat, n: String(prev.name || ""), u: user ? user.id : undefined, ou: prev.u, by: isOwner && user && user.id !== prev.u ? "owner" : undefined, at: Date.now() });
      }
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
