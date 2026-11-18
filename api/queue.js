// Vercel serverless function: /api/queue — the booking queue of one trip (see _queue.js). Needs env PAYMENT_QUEUE=1.
//   GET  ?t=code                      -> { on, items, turn, mine, role }   (LINE name/photo of a claimed row: organizers only)
//   POST {t, a: "on", value}          organizer: turn the queue on / off
//        {t, a: "auto", value}        organizer: true = "this is me" is approved at once (no organizer check)
//        {t, a: "add", names: [..]}   organizer: add passengers at the end (one name per entry)
//        {t, a: "remove" | "up" | "down" | "unbind", id}   organizer
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
    const t = L.tripId((req.query && req.query.t) || body.t);
    const trip = t && (await L.loadTrip(t));
    if (!trip) return L.json(res, 404, { error: "no_trip" });
    const user = await L.currentUser(req);
    const role = L.roleOf(trip, user), org = !!role;
    const cap = Math.min(Q.MAX_ITEMS, Math.max(1, (trip.vans || []).length) * L.TOTAL_SEATS); // one name per seat across every van

    const view = (q) => {
      const h = Q.turnOf(q), mine = user ? q.items.find((i) => i.u === user.id) : null;
      return {
        on: !!q.on, auto: !!q.auto, cap, role: role || undefined, turn: h ? h.id : null, mine: mine ? mine.id : null, me: L.publicUser(user), ended: L.tripEnded(trip),
        items: q.items.map((i) => Object.assign({ id: i.id, name: org || (user && !mine) || (mine && i === mine) ? i.name : "" }, // a passenger sees the names only while finding their own; signed out or already in the queue: only their own i.done ? { done: 1 } : {}, i.u ? { bound: 1 } : {}, i.ok ? { ok: 1 } : {},
          user && i.u === user.id ? { m: 1 } : {}, org && i.u && i.ln ? { ln: String(i.ln), lp: String(i.lp || "") } : {})),
      };
    };

    if (req.method === "GET") {
      const { q } = await Q.read(t);
      res.setHeader("Cache-Control", "no-store");
      return L.json(res, 200, view(q));
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return L.json(res, 405, { error: "method_not_allowed" }); }
    if (!user) return L.json(res, 401, { error: "login_required" });
    if (L.tripEnded(trip)) return L.json(res, 403, { error: "ended" });
    if (await L.rateLimited(req, user, "queue:" + t, 120, 600)) return L.json(res, 429, { error: "too_many" });
    const a = String(body.a || ""), id = String(body.id || "");
    const orgActs = ["on", "auto", "okall", "add", "remove", "up", "down", "unbind", "ok", "done"];
    if (orgActs.includes(a) && !org) return L.json(res, 403, { error: "not_owner" });
    const row = (q) => q.items.find((i) => i.id === id);
    let fn = null;

    if (a === "auto") fn = (q) => { const v = body.value === true; if (!!q.auto === v) return false; if (v) q.auto = 1; else delete q.auto; }; // true: "this is me" counts at once, no approval
    else if (a === "on") fn = (q) => { const v = body.value === true; if (q.on === v) return false; q.on = v; };
    else if (a === "add") {
      const names = (Array.isArray(body.names) ? body.names : [body.name]).map((x) => L.cleanName(String(x == null ? "" : x).replace(/\s+/g, " ").trim()).text).filter((x) => x && L.hasBaseLetter(x) && !L.reservedName(x, true)).slice(0, Q.MAX_ITEMS);
      if (!names.length) return L.json(res, 400, { error: "bad_name" });
      fn = (q) => { if (q.items.length + names.length > cap) return { error: "queue_full", cap }; names.forEach((n) => q.items.push({ id: L.newId(6), name: n })); };
    }
    else if (a === "remove") fn = (q) => { const n = q.items.length; q.items = q.items.filter((i) => i.id !== id); if (q.items.length === n) return false; };
    else if (a === "up" || a === "down") fn = (q) => {
      const i = q.items.findIndex((x) => x.id === id), j = i + (a === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= q.items.length) return false;
      const tmp = q.items[i]; q.items[i] = q.items[j]; q.items[j] = tmp;
    };
    else if (a === "unbind") fn = (q) => { const r = row(q); if (!r || !r.u) return false; delete r.u; delete r.ln; delete r.lp; delete r.ok; };
    else if (a === "okall") fn = (q) => { let n = 0; q.items.forEach((r) => { if (r.u && !r.ok && !r.done) { r.ok = 1; n++; } }); if (!n) return false; };
    else if (a === "ok") fn = (q) => { const r = row(q); if (!r || !r.u) return false; const v = body.value !== false; if (!!r.ok === v) return false; if (v) r.ok = 1; else delete r.ok; };
    else if (a === "done") fn = (q) => { const r = row(q); if (!r) return false; const v = body.value !== false; if (!!r.done === v) return false; if (v) r.done = 1; else delete r.done; };
    else if (a === "claim") fn = (q) => {
      if (q.items.some((i) => i.u === user.id)) return { error: "already_claimed" };
      const r = row(q); if (!r) return { error: "no_row" };
      if (r.u) return { error: "row_taken" };
      r.u = user.id; r.ln = user.name || ""; r.lp = user.pic || ""; if (q.auto) r.ok = 1; else delete r.ok; // otherwise the organizer approves it next
    };
    else if (a === "unclaim") fn = (q) => { const r = q.items.find((i) => i.u === user.id); if (!r || r.done) return false; delete r.u; delete r.ln; delete r.lp; delete r.ok; };
    else if (a === "finish") fn = (q) => { const h = Q.turnOf(q); if (!h || h.u !== user.id) return { error: "not_your_turn" }; h.done = 1; };
    else return L.json(res, 400, { error: "bad_action" });

    const out = await Q.update(trip, fn);
    if (out.error) return L.json(res, out.error === "busy" ? 409 : out.error === "not_your_turn" ? 403 : 400, { error: out.error });
    if (a === "claim" && out.changed && !out.q.auto) { // tell the organizer team that someone is waiting for approval
      const r = out.q.items.find((i) => i.u === user.id);
      await L.notify(L.teamIds(trip), { k: "queue_claim", t, tn: trip.name, n: r ? r.name : "" }, user.id);
    }
    return L.json(res, 200, Object.assign({ ok: true }, view(out.q)));
  } catch (e) {
    await L.errLog("queue", req, e);
    return L.json(res, 502, { error: "storage_error" });
  }
};
