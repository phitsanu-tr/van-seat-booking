// Vercel serverless function: GET / POST / DELETE /api/seats
// Query / body: t = trip code (default "default"), v = van id (default: the trip's first van).
// Storage: one Redis hash per van (field = seat number, value = JSON {name, at, u}).
// Seat hold: POST {hold: seat} (no sign-in needed) keeps a free seat for HOLD_SEC while the visitor signs in with LINE;
// others see it as "being booked"; the booking that carries the hold id gets it. One hold per browser (hc) per trip;
// the network only limits how many holds can be made (many phones share one IP on mobile networks).
const L = require("./_lib");
const HOLD_SEC = 5 * 60;
const holdKey = (t, v, s) => "hold:" + t + ":" + v + ":" + s;

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
    const role = L.roleOf(trip, user);
    const isOwner = !!role; // organizer: the owner or a helper (both manage seats)
    const closed = L.bookingClosed(trip); // passengers can't book, hold or cancel; organizers can

    if (req.method === "GET") {
      const cmds = [["HGETALL", key], ["MGET"].concat(Array.from({ length: L.TOTAL_SEATS }, (_, i) => holdKey(t, van.id, i + 1)))].concat(trip.vans.map((x) => ["HLEN", L.seatsKey(t, x.id)]));
      if (user) cmds.push(["GET", L.inboxVerKey(user.id)]); // notifications version: the page reloads the bell when it moves
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
      trip.vans.forEach((x, i) => { counts[x.id] = Number(out[i + 2]) || 0; });
      const held = []; (out[1] || []).forEach((h, i) => { if (h && !seats[i + 1]) held.push(i + 1); }); // free seats someone is signing in to book
      return L.json(res, 200, { trip: L.publicTrip(trip), van: van.id, seats, counts, ended: L.tripEnded(trip), me: L.publicUser(user), owner: isOwner, held, ib: user ? Number(out[2 + trip.vans.length]) || 0 : undefined, limit: L.maxPerPerson(trip), closed });
    }

    if ((req.method === "POST" || req.method === "DELETE") && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    const flagOnly = req.method === "PATCH" && (body.paid !== undefined || body.board !== undefined); // organizer ticks: many in a row on the trip day
    if ((req.method === "POST" || req.method === "DELETE" || req.method === "PATCH") && await L.rateLimited(req, user, flagOnly ? "flag:" + t : "seat:" + t, flagOnly ? 400 : 30, 600)) return L.json(res, 429, { error: "too_many" });
    if ((req.method === "PATCH" || (req.method === "POST" && body.move)) && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    if (req.method === "POST" && body.hold !== undefined && body.seat === undefined) {
      const seat = L.parseSeat(body.hold);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (closed) return L.json(res, 403, { error: "closed" });
      const hc = /^[a-z0-9]{16}$/.test(String(body.hc || "")) ? String(body.hc) : "";
      if (await L.rateLimited(req, null, "hold:" + t, hc ? 40 : 10, 600)) return L.json(res, 429, { error: "too_many" }); // per network
      if (hc && await L.rateLimited(req, { id: "hc:" + hc }, "hold:" + t, 10, 600)) return L.json(res, 429, { error: "too_many" }); // per browser
      if (await L.redis(["HGET", key, String(seat)])) return L.json(res, 409, { error: "taken" });
      const hk = holdKey(t, van.id, seat), id = L.newId(16), mineKey = hc ? "holdc:" + t + ":" + hc : "holdip:" + t + ":" + L.clientIp(req);
      const prev = await L.redis(["GET", mineKey]);
      if (prev && prev !== hk) { try { await L.redis(["DEL", prev]); } catch (e) { /* best effort */ } } // one hold per network: the new one replaces the old
      if (prev === hk) await L.redis(["DEL", hk]); // same seat again: renew
      const ok = await L.redis(["SET", hk, id, "NX", "EX", String(HOLD_SEC)]);
      if (ok !== "OK") return L.json(res, 409, { error: "held" });
      await L.redis(["SET", mineKey, hk, "EX", String(HOLD_SEC)]);
      return L.json(res, 200, { hold: id, exp: Date.now() + HOLD_SEC * 1000 });
    }

    if (req.method === "PATCH" && (body.paid !== undefined || body.board !== undefined)) {
      // organizer's own notes on a seat: paid (p = 1) and boarded on the trip day (c = time). Stored in the seat record,
      // so they follow the passenger when the seat is moved and vanish when it is cancelled. Passengers never see them.
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (!isOwner) return L.json(res, 403, { error: "not_owner" });
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      const raw = await L.redis(["HGET", key, String(seat)]);
      let rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (!rec) return L.json(res, 404, { error: "no_seat" });
      if (body.paid !== undefined) { if (body.paid === true) rec.p = 1; else delete rec.p; }
      if (body.board !== undefined) { if (body.board === true) rec.c = rec.c || Date.now(); else delete rec.c; }
      await L.redis(["HSET", key, String(seat), JSON.stringify(rec)]);
      if (body.paid !== undefined) await L.logEvent(t, { e: body.paid === true ? "paid" : "unpaid", v: van.id, s: seat, n: rec.name, u: user.id, by: role, at: Date.now() });
      return L.json(res, 200, { ok: true, p: rec.p ? 1 : 0, c: rec.c || 0 });
    }

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
      await L.logEvent(t, { e: "rename", v: van.id, s: seat, n: name, on: old, u: user.id, by: isOwner && rec.u !== user.id ? role : undefined, at: Date.now() });
      if (rec.u && rec.u !== user.id) await L.notify([rec.u], { k: "seat_renamed", t, tn: trip.name, vl: van.label, s: seat, o: old, n: name, by: role });
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
      await L.notify(a.u ? [a.u] : [], { k: "seat_moved", t, tn: trip.name, fvl: fromVan.label, fs, tvl: toVan.label, ts, by: role }, user.id);
      if (b && b.u) await L.notify([b.u], { k: "seat_moved", t, tn: trip.name, fvl: toVan.label, fs: ts, tvl: fromVan.label, ts: fs, by: role }, user.id);
      await L.logEvent(t, { e: b ? "swap" : "move", v: fromVan.id, s: fs, tv: toVan.id, ts, n: a.name, n2: b ? b.name : undefined, u: user.id, by: role, at: Date.now() });
      return L.json(res, 200, { ok: true, swapped: !!b });
    }

    if (req.method === "POST") {
      if (!user) return L.json(res, 401, { error: "login_required" });
      const seat = L.parseSeat(body.seat);
      const rawName = String(body.name || "");
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!rawName.trim()) return L.json(res, 400, { error: "bad_name" });
      const name = L.cleanName(rawName).text;
      if (name !== rawName || !L.hasBaseLetter(name)) return L.json(res, 400, { error: "name_chars" });
      if (closed && !isOwner) return L.json(res, 403, { error: "closed" });
      const limit = L.maxPerPerson(trip);
      if (user && !isOwner && limit > 0) { // count this account's seats in every van of the trip
        const all = await L.pipeline(trip.vans.map((x) => ["HGETALL", L.seatsKey(t, x.id)]));
        let mineN = 0;
        all.forEach((flat) => { for (let i = 1; i < (flat || []).length; i += 2) { try { if (JSON.parse(flat[i]).u === user.id) mineN++; } catch (e) { /* skip */ } } });
        if (mineN >= limit) return L.json(res, 403, { error: "seat_limit", limit });
      }
      const hk = holdKey(t, van.id, seat), holder = await L.redis(["GET", hk]);
      if (holder && holder !== String(body.hold || "")) return L.json(res, 409, { error: "held" }); // someone is signing in to book it
      const at = Date.now();
      // HSETNX only writes when the seat is still empty, so two people can never take the same seat.
      const rec = { name, at, u: user.id };
      const created = await L.redis(["HSETNX", key, String(seat), JSON.stringify(rec)]);
      if (created !== 1) return L.json(res, 409, { error: "taken" });
      if (holder) { try { await L.redis(["DEL", hk]); } catch (e) { /* expires anyway */ } }
      { try { await L.pipeline([["SADD", L.mySeatsKey(user.id), t + "|" + van.id + "|" + seat], ["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* the seat is booked; the index is best effort */ } }
      const exp = L.expireAtFor(trip);
      const live = exp && exp > Math.floor(Date.now() / 1000);
      if (live) { try { await L.redis(["EXPIREAT", key, String(exp)]); } catch (e) { /* best effort */ } } // a new van hash has no TTL yet
      await L.logEvent(t, { e: "book", v: van.id, s: seat, n: name, u: user.id, at }, live ? exp : undefined);
      return L.json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!user) return L.json(res, 401, { error: "login_required" });
      const raw = await L.redis(["HGET", key, String(seat)]);
      if (raw === null) return L.json(res, 200, { ok: true });
      let prev = {};
      try { prev = JSON.parse(raw) || {}; } catch (e) { /* damaged entry */ }
      // Only the person who booked the seat, or the trip's organizer, can cancel it.
      if (!((prev.u && user.id === prev.u) || isOwner)) return L.json(res, 403, { error: "not_yours" });
      if (closed && !isOwner) return L.json(res, 403, { error: "closed" }); // after closing, only the organizer changes the list
      const removed = await L.redis(["HDEL", key, String(seat)]);
      if (Number(removed) === 1) {
        if (prev.u) { try { await L.redis(["SREM", L.mySeatsKey(prev.u), t + "|" + van.id + "|" + seat]); } catch (e) { /* best effort */ } }
        if (prev.u && prev.u !== user.id) await L.notify([prev.u], { k: "seat_cancelled", t, tn: trip.name, vl: van.label, s: seat, by: role });
        await L.logEvent(t, { e: "cancel", v: van.id, s: seat, n: String(prev.name || ""), u: user.id, ou: prev.u, by: isOwner && user.id !== prev.u ? role : undefined, at: Date.now() });
      }
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
