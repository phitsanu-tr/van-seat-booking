// Vercel serverless function: GET / POST / DELETE /api/seats
// Query / body: t = trip code (default "default"), v = van id (default: the trip's first van).
// Storage: one Redis hash per van (field = seat number, value = JSON {name, at, u}).
// Seat hold: POST {hold: seat} (no sign-in needed) keeps a free seat for HOLD_SEC while the visitor signs in with LINE;
// others see it as "being booked"; the booking that carries the hold id gets it. One hold per browser (hc) per trip;
// the network only limits how many holds can be made (many phones share one IP on mobile networks).
const L = require("./_lib");
const HOLD_SEC = 5 * 60;
const MAX_HOLDS_IP = 5; // live holds one network may keep on one trip, whatever "browser codes" (hc) it sends: stops one person holding every seat
const holdKey = (t, v, s) => "hold:" + t + ":" + v + ":" + s;

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });

  if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
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
          if (v && v.name) seats[n] = Object.assign({ name: String(v.name), at: v.at }, v.u ? { a: 1 } : {}, v.u && user && v.u === user.id ? { m: 1 } : {},
            isOwner && v.u && v.ln ? { ln: String(v.ln), lp: String(v.lp || "") } : {}); // the organizer team sees the booker's LINE name and photo
        } catch (e) { /* skip a damaged entry */ }
      }
      const counts = {};
      trip.vans.forEach((x, i) => { counts[x.id] = Number(out[i + 2]) || 0; });
      const held = []; (out[1] || []).forEach((h, i) => { if (h && !seats[i + 1]) held.push(i + 1); }); // free seats someone is signing in to book
      return L.json(res, 200, { trip: L.publicTrip(trip), van: van.id, seats, counts, ended: L.tripEnded(trip), me: L.publicUser(user), owner: isOwner, held, ib: user ? Number(out[2 + trip.vans.length]) || 0 : undefined, limit: L.maxPerPerson(trip), closed });
    }

    if ((req.method === "POST" || req.method === "DELETE") && L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });

    const flagOnly = req.method === "PATCH" && body.board !== undefined; // organizer check-in ticks: many in a row on the trip day
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
      const ipSet = "holdset:" + t + ":" + L.clientIp(req), mem = ((await L.redis(["SMEMBERS", ipSet])) || []).filter((k) => k !== hk && /^hold:[a-z0-9]+:[A-Za-z0-9]+:\d+$/.test(k));
      if (mem.length) { const vals = (await L.redis(["MGET"].concat(mem))) || []; if (vals.filter(Boolean).length >= MAX_HOLDS_IP) return L.json(res, 429, { error: "too_many" }); }
      const ok = await L.redis(["SET", hk, id, "NX", "EX", String(HOLD_SEC)]);
      if (ok !== "OK") return L.json(res, 409, { error: "held" });
      try { await L.pipeline([["SADD", ipSet, hk], ["EXPIRE", ipSet, String(HOLD_SEC * 2)]]); } catch (e) { /* best effort */ }
      await L.redis(["SET", mineKey, hk, "EX", String(HOLD_SEC)]);
      return L.json(res, 200, { hold: id, exp: Date.now() + HOLD_SEC * 1000 });
    }

    if (req.method === "PATCH" && body.note !== undefined) {
      // organizer's note on a seat (pickup point, who paid, ...): follows the passenger when moved, gone when cancelled.
      // Passengers never see it; it shows in the roster sheet and the downloaded list.
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (!isOwner) return L.json(res, 403, { error: "not_owner" });
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      const nt = String(body.note || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
      let rec = null;
      for (let tries = 0; ; tries++) {
        const raw = await L.redis(["HGET", key, String(seat)]);
        rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
        if (!rec) return L.json(res, 404, { error: "no_seat" });
        if ((rec.nt || "") === nt) break;
        if (nt) rec.nt = nt; else delete rec.nt;
        if (await L.hcas([{ key, field: seat, expect: raw, value: JSON.stringify(rec) }])) break;
        if (tries >= 3) return L.json(res, 409, { error: "busy" });
      }
      return L.json(res, 200, { ok: true, note: nt });
    }

    if (req.method === "PATCH" && body.board !== undefined) {
      // organizer's own note on a seat: boarded on the trip day (c = time). Stored in the seat record,
      // so they follow the passenger when the seat is moved and vanish when it is cancelled. Passengers never see them.
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (!isOwner) return L.json(res, 403, { error: "not_owner" });
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      // read -> change -> write only if the seat is still exactly what was read (else read again; a cancelled seat stays cancelled)
      let rec = null;
      for (let tries = 0; ; tries++) {
        const raw = await L.redis(["HGET", key, String(seat)]);
        rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
        if (!rec) return L.json(res, 404, { error: "no_seat" });
        // c = boarded at, cb = which organizer ticked it (names the round's checker)
        if (body.board === true) { if (rec.c) break; rec.c = Date.now(); rec.cb = String(user.name || "").slice(0, 40); } else { if (!rec.c) break; delete rec.c; delete rec.cb; }
        if (await L.hcas([{ key, field: seat, expect: raw, value: JSON.stringify(rec) }])) break;
        if (tries >= 3) return L.json(res, 409, { error: "busy" });
      }
      return L.json(res, 200, { ok: true, c: rec.c || 0 });
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
      if (L.reservedName(name, isOwner)) return L.json(res, 400, { error: "name_reserved" });
      let rec = null, old = "";
      for (let tries = 0; ; tries++) {
        const raw = await L.redis(["HGET", key, String(seat)]);
        rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
        if (!rec) return L.json(res, 404, { error: "no_seat" });
        if (!(rec.u ? rec.u === user.id || isOwner : isOwner)) return L.json(res, 403, { error: "not_yours" });
        old = rec.name; rec.name = name;
        if (rec.u === user.id) { rec.ln = user.name || ""; rec.lp = user.pic || ""; } // the booker's own rename refreshes their LINE name
        if (await L.hcas([{ key, field: seat, expect: raw, value: JSON.stringify(rec) }])) break; // the seat may have been cancelled or re-booked meanwhile
        if (tries >= 3) return L.json(res, 409, { error: "busy" });
      }
      await L.logEvent(t, { e: "rename", v: van.id, s: seat, n: name, on: old, u: user.id, by: isOwner && rec.u !== user.id ? role : undefined, at: Date.now() });
      if (rec.u && rec.u !== user.id) await L.notify([rec.u], { k: "seat_renamed", t, tn: trip.name, vl: van.label, s: seat, o: old, n: name, by: role });
      return L.json(res, 200, { ok: true, name, at: rec.at });
    }

    if (req.method === "POST" && body.import !== undefined) {
      // organizer imports a passenger list (from a CSV file or pasted text, parsed by the page). apply:false = check only
      // (nothing is written); apply:true = write the rows that passed. Seats are written with HSETNX, so a seat someone
      // took in the meantime is never overwritten. An existing seat with the same name is left alone (a new note is added).
      if (!user) return L.json(res, 401, { error: "login_required" });
      if (!isOwner) return L.json(res, 403, { error: "not_owner" });
      if (L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });
      if (await L.rateLimited(req, user, "import", 30, 600)) return L.json(res, 429, { error: "too_many" });
      const im = body.import || {}, rowsIn = Array.isArray(im.rows) ? im.rows.slice(0, 300) : [];
      if (!rowsIn.length) return L.json(res, 400, { error: "no_rows" });
      const allSeats = await L.pipeline(trip.vans.map((x) => ["HGETALL", L.seatsKey(t, x.id)]));
      const cur = {}, used = {};
      trip.vans.forEach((x, i) => {
        const flat = allSeats[i] || [], m = {};
        for (let j = 0; j + 1 < flat.length; j += 2) { const n = L.parseSeat(flat[j]); if (n === null) continue; try { const r = JSON.parse(flat[j + 1]); if (r && r.name) m[n] = r; } catch (e) { /* skip */ } }
        cur[x.id] = m; used[x.id] = new Set(Object.keys(m).map(Number));
      });
      const findVan = (txt) => {
        const s = String(txt || "").trim().toLowerCase(), f = s.replace(/^(รถคัน|รถตู้|รถ|คัน|van)\s*/, "");
        return trip.vans.find((x) => x.id.toLowerCase() === s || String(x.label).toLowerCase() === s || String(x.label).toLowerCase() === f) || null;
      };
      const defVan = trip.vans.find((x) => x.id === String(im.defVan || "")) || null;
      const items = rowsIn.map((r, i) => ({ i, st: "", msg: "", name: "", nt: "", van: null, seat: 0, raw: r || {} }));
      // 1) validate names / vans; 2) explicit seats; 3) rows without a seat take the next free one
      items.forEach((it) => {
        const r = it.raw, rawName = String(r.name == null ? "" : r.name).replace(/\s+/g, " ").trim();
        if (!rawName) { it.st = "err"; it.msg = "ไม่มีชื่อ"; return; }
        const name = L.cleanName(rawName).text;
        if (name !== rawName || !L.hasBaseLetter(name)) { it.st = "err"; it.msg = "ชื่อมีตัวอักษรที่ไม่รองรับ (ใช้ได้เฉพาะไทย/อังกฤษ)"; return; }
        if (L.reservedName(name, true)) { it.st = "err"; it.msg = "ชื่อนี้ใช้ไม่ได้"; return; }
        it.name = name;
        it.nt = String(r.note == null ? "" : r.note).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
        const vt = String(r.v == null ? "" : r.v).trim();
        if (vt) { it.van = findVan(vt); if (!it.van) { it.st = "err"; it.msg = "ไม่มีรถคัน " + vt.slice(0, 12) + " ในทริปนี้"; } }
        else it.van = defVan;
      });
      items.forEach((it) => {
        if (it.st) return;
        const st = String(it.raw.s == null ? "" : it.raw.s).trim();
        if (!st) return;
        const n = L.parseSeat(st);
        if (n === null) { it.st = "err"; it.msg = "เลขที่นั่งไม่ถูกต้อง (1–" + L.TOTAL_SEATS + ")"; return; }
        const van = it.van || trip.vans[0]; it.van = van; it.seat = n;
        const have = cur[van.id][n];
        if (have) {
          if (have.name === it.name) { it.st = it.nt && it.nt !== (have.nt || "") ? "note" : "same"; it.msg = it.st === "note" ? "เพิ่มหมายเหตุ" : "มีอยู่แล้ว"; }
          else { it.st = "err"; it.msg = "ที่นั่ง " + n + " มีคนจองแล้ว (" + String(have.name).slice(0, 20) + ")"; }
          return;
        }
        if (used[van.id].has(n)) { it.st = "err"; it.msg = "ที่นั่ง " + n + " ซ้ำกับแถวก่อนหน้า"; return; }
        used[van.id].add(n); it.st = "new";
      });
      items.forEach((it) => {
        if (it.st) return;
        const pool = it.van ? [it.van] : trip.vans;
        for (const van of pool) {
          for (let n = trip.staffSeat ? 2 : 1; n <= L.TOTAL_SEATS; n++) if (!used[van.id].has(n)) { used[van.id].add(n); it.van = van; it.seat = n; it.st = "auto"; return; }
        }
        it.st = "err"; it.msg = "ไม่มีที่ว่าง" + (it.van ? " ในรถคัน " + it.van.label : "");
      });
      let created = 0;
      if (im.apply === true) {
        const todo = items.filter((it) => it.st === "new" || it.st === "auto");
        const at = Date.now();
        if (todo.length) {
          const res1 = await L.pipeline(todo.map((it) => ["HSETNX", L.seatsKey(t, it.van.id), String(it.seat), JSON.stringify(Object.assign({ name: it.name, at, u: user.id, ln: user.name || "", lp: user.pic || "" }, it.nt ? { nt: it.nt } : {}))]));
          todo.forEach((it, k) => { if (Number(res1[k]) === 1) { created++; it.done = true; } else { it.st = "err"; it.msg = "มีคนจองไปก่อนแล้ว"; } });
        }
        for (const it of items.filter((x) => x.st === "note")) {
          const k2 = L.seatsKey(t, it.van.id), raw = await L.redis(["HGET", k2, String(it.seat)]); let rec = null; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
          if (rec && rec.name === it.name) { rec.nt = it.nt; await L.hcas([{ key: k2, field: it.seat, expect: raw, value: JSON.stringify(rec) }]); }
        }
        const made = items.filter((x) => x.done);
        if (made.length) {
          try { await L.pipeline([["SADD", L.mySeatsKey(user.id)].concat(made.map((x) => t + "|" + x.van.id + "|" + x.seat)), ["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* index is best effort */ }
          const exp = L.expireAtFor(trip), live = exp && exp > Math.floor(Date.now() / 1000);
          if (live) { for (const vv of new Set(made.map((x) => x.van.id))) { try { await L.redis(["EXPIREAT", L.seatsKey(t, vv), String(exp)]); } catch (e) { /* best effort */ } } }
          for (const x of made) await L.logEvent(t, { e: "book", v: x.van.id, s: x.seat, n: x.name, u: user.id, by: role, at }, live ? exp : undefined);
          L.bump("seat_book", made.length);
        }
      }
      const counts = { new: 0, auto: 0, same: 0, note: 0, err: 0 };
      items.forEach((it) => { counts[it.st] = (counts[it.st] || 0) + 1; });
      return L.json(res, 200, { ok: true, applied: im.apply === true, created, counts, items: items.map((it) => ({ i: it.i, st: it.st, msg: it.msg, name: it.name, nt: it.nt, vl: it.van ? it.van.label : "", s: it.seat || 0 })) });
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
      // both seats change in one atomic step, and only if neither changed since they were read (no half-done move, no overwrite)
      const moved = await L.hcas([{ key: tk, field: ts, expect: tr || "", value: fr }, { key: fk, field: fs, expect: fr, value: b ? tr : "" }]);
      if (!moved) {
        const [fr2, tr2] = await L.pipeline([["HGET", fk, String(fs)], ["HGET", tk, String(ts)]]);
        return L.json(res, 409, { error: !fr2 ? "no_seat" : tr2 && m.swap !== true ? "taken" : "busy" });
      }
      const ref = (v, s) => t + "|" + v + "|" + s, cmds = [];
      if (a.u) cmds.push(["SREM", L.mySeatsKey(a.u), ref(fromVan.id, fs)], ["SADD", L.mySeatsKey(a.u), ref(toVan.id, ts)]);
      if (b && b.u) cmds.push(["SREM", L.mySeatsKey(b.u), ref(toVan.id, ts)], ["SADD", L.mySeatsKey(b.u), ref(fromVan.id, fs)]);
      if (cmds.length) { try { await L.pipeline(cmds); } catch (e) { /* the move is done; the "my seats" index is best effort */ } }
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
      if (L.reservedName(name, isOwner)) return L.json(res, 400, { error: "name_reserved" });
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
      const rec = { name, at, u: user.id, ln: user.name || "", lp: user.pic || "" }; // LINE name + photo: shown to the organizer team only
      const created = await L.redis(["HSETNX", key, String(seat), JSON.stringify(rec)]);
      if (created !== 1) return L.json(res, 409, { error: "taken" });
      if (user && !isOwner && limit > 0) { // two bookings at the same moment can both pass the check above: count again now and give this one back if the person is over the limit
        const all2 = await L.pipeline(trip.vans.map((x) => ["HGETALL", L.seatsKey(t, x.id)]));
        let n2 = 0;
        all2.forEach((flat) => { for (let i = 1; i < (flat || []).length; i += 2) { try { if (JSON.parse(flat[i]).u === user.id) n2++; } catch (e) { /* skip */ } } });
        if (n2 > limit) { await L.hcas([{ key, field: seat, expect: JSON.stringify(rec), value: "" }]); return L.json(res, 403, { error: "seat_limit", limit }); }
      }
      if (holder) { try { await L.redis(["DEL", hk]); } catch (e) { /* expires anyway */ } }
      { try { await L.pipeline([["SADD", L.mySeatsKey(user.id), t + "|" + van.id + "|" + seat], ["EXPIRE", L.mySeatsKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* the seat is booked; the index is best effort */ } }
      const exp = L.expireAtFor(trip);
      const live = exp && exp > Math.floor(Date.now() / 1000);
      if (live) { try { await L.redis(["EXPIREAT", key, String(exp)]); } catch (e) { /* best effort */ } } // a new van hash has no TTL yet
      L.bump("seat_book");
      await L.logEvent(t, { e: "book", v: van.id, s: seat, n: name, u: user.id, at }, live ? exp : undefined);
      return L.json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const seat = L.parseSeat(body.seat);
      if (seat === null) return L.json(res, 400, { error: "bad_seat" });
      if (!user) return L.json(res, 401, { error: "login_required" });
      // read -> check it is theirs -> remove only if the seat is still exactly what was read. A check-in tick in between only
      // changes the record, so read again and cancel that; a seat re-booked by someone else in between fails the ownership check.
      let prev = {}, removed = 0;
      for (let tries = 0; ; tries++) {
        const raw = await L.redis(["HGET", key, String(seat)]);
        if (raw === null) return L.json(res, 200, { ok: true });
        prev = {};
        try { prev = JSON.parse(raw) || {}; } catch (e) { /* damaged entry */ }
        // Only the person who booked the seat, or the trip's organizer, can cancel it.
        if (!((prev.u && user.id === prev.u) || isOwner)) return L.json(res, 403, { error: "not_yours" });
        if (closed && !isOwner) return L.json(res, 403, { error: "closed" }); // after closing, only the organizer changes the list
        if (await L.hcas([{ key, field: seat, expect: raw, value: "" }])) { removed = 1; break; }
        if (tries >= 3) return L.json(res, 409, { error: "busy" });
      }
      if (Number(removed) === 1) {
        L.bump("seat_cancel");
        if (prev.u) { try { await L.redis(["SREM", L.mySeatsKey(prev.u), t + "|" + van.id + "|" + seat]); } catch (e) { /* best effort */ } }
        if (prev.u && prev.u !== user.id) await L.notify([prev.u], { k: "seat_cancelled", t, tn: trip.name, vl: van.label, s: seat, by: role });
        await L.logEvent(t, { e: "cancel", v: van.id, s: seat, n: String(prev.name || ""), u: user.id, ou: prev.u, by: isOwner && user.id !== prev.u ? role : undefined, at: Date.now() });
        if (prev.st === 1 && trip.staffSeat) { // the last team seat 1 cancelled: the trip's switch turns itself off
          try {
            const got = await L.pipeline(trip.vans.map((x) => ["HGET", L.seatsKey(t, x.id), "1"]));
            const any = got.some((g) => { try { return JSON.parse(g).st === 1; } catch (e) { return false; } });
            if (!any) { const fresh = await L.loadTrip(t); if (fresh && fresh.staffSeat) { fresh.staffSeat = false; await L.redis(["SET", L.tripKey(t), JSON.stringify(fresh)]); await L.applyExpiry(fresh); } }
          } catch (e) { /* best effort */ }
        }
      }
      return L.json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: "storage_error" });
  }
};
