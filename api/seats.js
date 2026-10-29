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
      return L.json(res, 200, { trip: L.publicTrip(trip), van: van.id, seats, counts, ended: L.tripEnded(trip), me: L.publicUser(user), owner: isOwner, needLogin: L.REQUIRE_LOGIN });
    }

    if ((req.method === "POST" || req.method === "DELETE") && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    if (req.method === "POST" && Array.isArray(body.claim)) {
      // Signed-in visitor takes over the seats booked from this browser before signing in:
      // a seat moves to the account only if it has no account yet and both the booking time and the browser id match.
      if (!user) return L.json(res, 401, { error: "login_required" });
      const d = /^[A-Za-z0-9-]{8,64}$/.test(String(body.d || "")) ? String(body.d) : "";
      const list = body.claim.slice(0, 10).map((c) => ({ s: L.parseSeat(c && c.s), at: Number(c && c.at) })).filter((c) => c.s !== null && c.at > 0);
      if (!d || !list.length) return L.json(res, 200, { claimed: [] });
      const raws = await L.pipeline(list.map((c) => ["HGET", key, String(c.s)]));
      const claimed = [], cmds = [];
      list.forEach((c, i) => {
        let rec = null;
        try { rec = JSON.parse(raws[i]); } catch (e) { rec = null; }
        if (!rec || rec.u || rec.d !== d || Number(rec.at) !== c.at) return;
        rec.u = user.id;
        cmds.push(["HSET", key, String(c.s), JSON.stringify(rec)]);
        cmds.push(["SADD", L.mySeatsKey(user.id), t + "|" + van.id + "|" + c.s]);
        claimed.push(c.s);
      });
      if (cmds.length) { cmds.push(["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]); await L.pipeline(cmds); }
      return L.json(res, 200, { claimed });
    }

    if ((req.method === "POST" || req.method === "DELETE") && await L.rateLimited(req, user, "seat:" + t, 30, 600)) return L.json(res, 429, { error: "too_many" });

    if (req.method === "POST") {
      if (L.REQUIRE_LOGIN && !user) return L.json(res, 401, { error: "login_required" });
      const seat = L.parseSeat(body.seat);
      const rawName = String(body.name || "");
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!rawName.trim()) return L.json(res, 400, { error: "bad_name" });
      const name = L.cleanName(rawName).text;
      if (name !== rawName || !L.hasBaseLetter(name)) return L.json(res, 400, { error: "name_chars" });
      const at = Date.now();
      const d = /^[A-Za-z0-9-]{8,64}$/.test(String(body.d || "")) ? String(body.d) : undefined; // random per-browser id, stored for the owner only (never sent back to other visitors)
      // HSETNX only writes when the seat is still empty, so two people can never take the same seat.
      const rec = { name, at };
      if (d) rec.d = d;
      if (user) rec.u = user.id;
      const created = await L.redis(["HSETNX", key, String(seat), JSON.stringify(rec)]);
      if (created !== 1) return L.json(res, 409, { error: "taken" });
      if (user) { try { await L.pipeline([["SADD", L.mySeatsKey(user.id), t + "|" + van.id + "|" + seat], ["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* the seat is booked; the index is best effort */ } }
      const exp = L.expireAtFor(trip);
      const live = exp && exp > Math.floor(Date.now() / 1000);
      if (live) { try { await L.redis(["EXPIREAT", key, String(exp)]); } catch (e) { /* best effort */ } } // a new van hash has no TTL yet
      await L.logEvent(t, { e: "book", v: van.id, s: seat, n: name, d, u: user ? user.id : undefined, at }, live ? exp : undefined);
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
      // A seat booked by a signed-in person can only be cancelled by that person or the trip's organizer.
      // Seats booked without an account (before the switch-over) can still be cancelled by anyone; the log keeps who did it.
      if (prev.u && !(user && (user.id === prev.u || isOwner))) return L.json(res, user ? 403 : 401, { error: user ? "not_yours" : "login_required" });
      const removed = await L.redis(["HDEL", key, String(seat)]);
      if (Number(removed) === 1) {
        const d = /^[A-Za-z0-9-]{8,64}$/.test(String(body.d || "")) ? String(body.d) : undefined;
        if (prev.u) { try { await L.redis(["SREM", L.mySeatsKey(prev.u), t + "|" + van.id + "|" + seat]); } catch (e) { /* best effort */ } }
        await L.logEvent(t, { e: "cancel", v: van.id, s: seat, n: String(prev.name || ""), d, od: prev.d, u: user ? user.id : undefined, ou: prev.u, by: isOwner && user && user.id !== prev.u ? "owner" : undefined, at: Date.now() });
      }
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
