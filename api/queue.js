// Vercel serverless function: /api/queue — the booking queues of one trip, one per van (add &v=<van id> / body v; default: the first van) (see _queue.js). Needs env PAYMENT_QUEUE=1.
//   GET  ?t=code                      -> { on, items, turn, mine, role }   (LINE name/photo of a claimed row: organizers only)
//   POST {t, a: "on", value}          organizer: turn the queue on / off
//        {t, a: "onall", value}       organizer: turn every van's queue on / off
//        {t, a: "auto", value}        organizer: true = "this is me" is approved at once (no organizer check)
//        {t, a: "add", names: [..]}   organizer: add passengers at the end (one name per entry)
//        {t, a: "remove" | "up" | "down" | "unbind", id}   organizer
//        {t, a: "rename", id, name}   organizer: fix the spelling of a name (place and LINE binding stay)
//        {t, a: "ok", id, value}      organizer: approve / withdraw approval of the account that claimed this row
//        {t, a: "done", id, value}    organizer: skip a row (done) / put it back
//        {t, a: "claim", id}          passenger (signed in): "this is me" on a free row; waits for approval
//        {t, a: "unclaim"}            passenger: take the claim back
//        {t, a: "finish"}             passenger whose turn it is: done choosing, the next one is called
const L = require("./_lib");
const Q = require("./_queue");

module.exports = async function handler(req, res) {
  if (L.tooBig(req)) return L.json(res, 413, { error: "too_big" });
  if (!L.REST_URL || !L.REST_TOKEN || !Q.flagOn()) return L.json(res, 404, { error: "off" });
  if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
  try {
    const body = req.method === "GET" ? {} : L.readBody(req);
    let t = L.tripId((req.query && req.query.t) || body.t), trip, wantV;
    const kRaw = (req.query && req.query.k) || body.k;
    if (kRaw) { // a van link: that van only
      if (await L.guessBlocked(req)) return L.json(res, 429, { error: "too_many" });
      const sc = await L.scopeOf(kRaw); if (!sc) { await L.guessMiss(req); return L.json(res, 404, { error: "bad_link" }); }
      trip = sc.trip; t = trip.id; wantV = sc.van.id;
    } else {
      trip = t && (await L.loadTrip(t));
      if (!trip) return L.json(res, 404, { error: "no_trip" });
      wantV = String((req.query && req.query.v) || body.v || "");
    }
    if (wantV && !(trip.vans || []).some((x) => x.id === wantV)) return L.json(res, 404, { error: "no_van" });
    const van = Q.vanOf(trip, wantV), vid = van.id; // every van of the trip has its own queue
    const user = await L.currentUser(req);
    const role = L.roleOf(trip, user), org = !!role;
    if (!kRaw && !org && (trip.vans || []).length > 1 && (req.method === "GET" || req.method === "POST")) return L.json(res, 403, { error: "organizer_only" }); // the trip-wide link is for the organizer team; passengers use their van's link
    const cap = Math.min(Q.MAX_ITEMS, L.TOTAL_SEATS); // one name per seat of this van
    const myE = Q.myEntry(trip, vid);
    // organizer: the state of every van's queue (for the van tabs)
    const vsum = async () => (await Q.readAll(trip)).map((x) => ({ id: x.id, l: x.label, on: x.q.on ? 1 : 0, n: x.q.items.filter((i) => !i.done).length, w: x.q.items.filter((i) => i.u && !i.ok && !i.done).length }));

    // a passenger sees other names only while finding their own; signed out or already in the queue: only their own
    let myN = 0; // seats this person already holds on the trip (tells "used the turn and booked" from "turn ended without a seat")
    if (user) { const refs = (await L.redis(["SMEMBERS", L.mySeatsKey(user.id)])) || []; myN = refs.filter((x) => String(x).indexOf(t + "|") === 0).length; }
    // organizer: which bound names hold seats on this trip (no "give the turn back" / "unlink" for them: the seat stays booked)
    const heldBy = {};
    const seatsOf = async (uid) => ((await L.redis(["SMEMBERS", L.mySeatsKey(uid)])) || []).filter((x) => String(x).indexOf(t + "|") === 0).length;
    const fillHeld = async (q) => { if (!org) return; const us = q.items.filter((i) => i.u).map((i) => i.u); const ns = await Promise.all(us.map(seatsOf)); us.forEach((u, k) => { heldBy[u] = ns[k]; }); };
    const view = (q) => {
      const h = Q.turnOf(q), mine = user ? q.items.find((i) => i.u === user.id) : null;
      return {
        v: vid, vl: van.label, on: !!q.on, auto: !!q.auto, cap, role: role || undefined, turn: h ? h.id : null, mine: mine ? mine.id : null, me: L.publicUser(user), ended: L.tripEnded(trip), closed: !!L.bookingClosed(trip), ...(mine ? { seats: myN } : {}),
        items: q.items.map((i) => Object.assign({ id: i.id, name: org || (user && !mine) || (mine && i === mine) ? i.name : "" }, i.done ? { done: 1 } : {}, i.u && heldBy[i.u] > 0 ? { hs: 1 } : {}, i.u ? { bound: 1 } : {}, i.ok ? { ok: 1 } : {},
          user && i.u === user.id ? { m: 1 } : {}, org && i.u && i.ln ? { ln: String(i.ln), lp: String(i.lp || "") } : {})),
      };
    };

    if (req.method === "GET") {
      const { q } = await Q.read(trip, vid);
      if (user && q.items.some((i) => i.u === user.id)) { try { await L.pipeline([["SADD", L.myQueueKey(user.id), myE], ["EXPIRE", L.myQueueKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort: also fills the list for people who joined before it existed */ } }
      res.setHeader("Cache-Control", "no-store");
      await fillHeld(q);
      return L.json(res, 200, Object.assign(view(q), org ? { vans: await vsum() } : {}));
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return L.json(res, 405, { error: "method_not_allowed" }); }
    if (!user) return L.json(res, 401, { error: "login_required" });
    if (L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });
    if (await L.rateLimited(req, user, "queue:" + t, 120, 600)) return L.json(res, 429, { error: "too_many" });
    const a = String(body.a || ""), id = String(body.id || "");
    const orgActs = ["on", "onall", "auto", "okall", "add", "remove", "up", "down", "unbind", "reject", "ok", "done", "rename"];
    if (orgActs.includes(a) && !org) return L.json(res, 403, { error: "not_owner" });
    const row = (q) => q.items.find((i) => i.id === id);
    let fn = null, rejUid = "", rejName = "";

    if (a === "auto") fn = (q) => { const v = body.value === true; if (!!q.auto === v) return false; if (v) q.auto = 1; else delete q.auto; }; // true: "this is me" counts at once, no approval
    else if (a === "on") fn = (q) => { const v = body.value === true; if (q.on === v) return false; q.on = v; };
    else if (a === "onall") { // every van at once
      const v = body.value === true;
      for (const x of trip.vans || []) { const r = await Q.update(trip, x.id, (q) => { if (!!q.on === v) return false; q.on = v; }); if (r.error) return L.json(res, 409, { error: r.error }); }
      fn = () => false;
    }
    else if (a === "add") {
      const names = (Array.isArray(body.names) ? body.names : [body.name]).map((x) => L.cleanName(String(x == null ? "" : x).replace(/\s+/g, " ").trim()).text).filter((x) => x && L.hasBaseLetter(x) && !L.reservedName(x, true)).slice(0, Q.MAX_ITEMS);
      if (!names.length) return L.json(res, 400, { error: "bad_name" });
      fn = (q) => { if (q.items.length + names.length > cap) return { error: "queue_full", cap }; names.forEach((n) => q.items.push({ id: L.newId(6), name: n })); };
    }
    else if (a === "rename") {
      const nn = L.cleanName(String(body.name == null ? "" : body.name).replace(/\s+/g, " ").trim()).text;
      if (!nn || !L.hasBaseLetter(nn) || L.reservedName(nn, true)) return L.json(res, 400, { error: "bad_name" });
      fn = (q) => { const r = row(q); if (!r || r.name === nn) return false; r.name = nn; };
    }
    else if (a === "remove") fn = (q) => { const n = q.items.length; q.items = q.items.filter((i) => i.id !== id); if (q.items.length === n) return false; };
    else if (a === "up" || a === "down") fn = (q) => {
      const i = q.items.findIndex((x) => x.id === id), j = i + (a === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= q.items.length) return false;
      const tmp = q.items[i]; q.items[i] = q.items[j]; q.items[j] = tmp;
    };
    else if (a === "reject") { // a name someone claimed but the organizer does not approve: same as unlinking it, and the person is told
      const { q: cur } = await Q.read(trip, vid); const r0 = cur.items.find((i) => i.id === id);
      if (!r0 || !r0.u || r0.ok) return L.json(res, 409, { error: "not_pending" });
      rejUid = r0.u; rejName = r0.name;
      fn = (q) => { const r = row(q); if (!r || !r.u || r.ok) return false; delete r.u; delete r.ln; delete r.lp; delete r.ok; };
    }
    else if (a === "unbind") {
      { const { q: cur } = await Q.read(trip, vid); const r0 = cur.items.find((i) => i.id === id); if (r0 && r0.u && (await seatsOf(r0.u)) > 0) return L.json(res, 409, { error: "has_seats" }); }
      fn = (q) => { const r = row(q); if (!r || !r.u) return false; delete r.u; delete r.ln; delete r.lp; delete r.ok; };
    }
    else if (a === "okall") fn = (q) => { let n = 0; q.items.forEach((r) => { if (r.u && !r.ok && !r.done) { r.ok = 1; n++; } }); if (!n) return false; };
    else if (a === "ok") fn = (q) => { const r = row(q); if (!r || !r.u) return false; const v = body.value !== false; if (!!r.ok === v) return false; if (v) r.ok = 1; else delete r.ok; };
    else if (a === "done") {
      if (body.value === false) { const { q: cur } = await Q.read(trip, vid); const r0 = cur.items.find((i) => i.id === id); if (r0 && r0.done && r0.u && (await seatsOf(r0.u)) > 0) return L.json(res, 409, { error: "has_seats" }); }
      fn = (q) => { const r = row(q); if (!r) return false; const v = body.value !== false; if (!!r.done === v) return false; if (v) r.done = 1; else delete r.done; };
    }
    else if (a === "claim") fn = (q) => {
      if (q.items.some((i) => i.u === user.id)) return { error: "already_claimed" };
      const r = row(q); if (!r) return { error: "no_row" };
      if (r.u) return { error: "row_taken" };
      r.u = user.id; r.ln = user.name || ""; r.lp = user.pic || ""; if (q.auto) r.ok = 1; else delete r.ok; // otherwise the organizer approves it next
    };
    else if (a === "unclaim") fn = (q) => { const r = q.items.find((i) => i.u === user.id); if (!r || r.done) return false; delete r.u; delete r.ln; delete r.lp; delete r.ok; };
    else if (a === "finish") fn = (q) => { const h = Q.turnOf(q); if (!h || h.u !== user.id) return { error: "not_your_turn" }; h.done = 1; };
    else return L.json(res, 400, { error: "bad_action" });

    const out = await Q.update(trip, vid, fn);
    if (out.error) return L.json(res, out.error === "busy" ? 409 : out.error === "not_your_turn" ? 403 : 400, { error: out.error });
    if (a === "claim" && out.changed) { try { await L.pipeline([["SADD", L.myQueueKey(user.id), myE], ["EXPIRE", L.myQueueKey(user.id), String(L.MY_DAYS * 86400)]]); } catch (e) { /* best effort */ } }
    if (a === "unclaim" && out.changed) { try { await L.redis(["SREM", L.myQueueKey(user.id), myE]); } catch (e) { /* best effort */ } }
    if (a === "reject" && out.changed && rejUid) {
      try { await L.redis(["SREM", L.myQueueKey(rejUid), myE]); } catch (e) { /* best effort */ }
      await L.notify([rejUid], { k: "queue_no", t, tn: trip.name, n: rejName, v: vid, vl: van.label, mv: (trip._nv || trip.vans.length) > 1 ? 1 : undefined, vk: L.vkOf(trip, van) }, user.id);
    }
    if (a === "claim" && out.changed && !out.q.auto) { // tell the organizer team that someone is waiting for approval
      const r = out.q.items.find((i) => i.u === user.id);
      await L.notify(L.teamIds(trip), { k: "queue_claim", t, tn: trip.name, n: r ? r.name : "", v: vid, vl: van.label, mv: (trip._nv || trip.vans.length) > 1 ? 1 : undefined }, user.id);
    }
    await fillHeld(out.q);
    return L.json(res, 200, Object.assign({ ok: true }, view(out.q), org ? { vans: await vsum() } : {}));
  } catch (e) {
    await L.errLog("queue", req, e);
    return L.json(res, 502, { error: "storage_error" });
  }
};
