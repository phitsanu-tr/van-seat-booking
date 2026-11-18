// Booking queue ("จองตามลำดับ"): the organizer team keeps a list of passengers in order (usually the order they paid); only the
// person whose turn it is may pick seats. Off unless env PAYMENT_QUEUE=1 (and then per trip, with queue.on).
// Storage: one Redis hash "queue:<trip>", field "q" = JSON { on, pn, items: [{ id, name, u?, ln?, lp?, ok?, done? }] }.
//   u = account that tapped "this is me", ok = the organizer approved that account for this name, done = turn over (or skipped).
//   pn = the item the "your turn" message went out for last (so nobody is told twice).
const L = require("./_lib");

const MAX_ITEMS = 80;
const flagOn = () => /^(1|true|on)$/i.test(String(process.env.PAYMENT_QUEUE || ""));
const qKey = (t) => "queue:" + t;
const head = (q) => (q && q.items.find((i) => !i.done)) || null;
const turnOf = (q) => { const h = q && q.on ? head(q) : null; return h && h.u && h.ok ? h : null; }; // who may book right now

async function read(t) {
  const raw = await L.redis(["HGET", qKey(t), "q"]);
  let q = null; try { q = JSON.parse(raw); } catch (e) { q = null; }
  if (!q || !Array.isArray(q.items)) q = { on: false, items: [] };
  return { raw: raw || "", q };
}

// read -> fn(q) changes it in place (return false = nothing to write) -> written only if nobody changed it meanwhile
async function update(trip, fn) {
  for (let tries = 0; tries < 5; tries++) {
    const { raw, q } = await read(trip.id);
    const r = fn(q);
    if (r === false) return { q, ok: true, changed: false };
    if (r && r.error) return { error: r.error, q };
    let turnUid = null;
    const h = turnOf(q);
    if (h && q.pn !== h.id) { q.pn = h.id; turnUid = h.u; } else if (!h && q.pn && !(q.on && head(q))) q.pn = "";
    if (await L.hcas([{ key: qKey(trip.id), field: "q", expect: raw, value: JSON.stringify(q) }])) {
      const exp = L.expireAtFor(trip);
      if (exp && exp > Math.floor(Date.now() / 1000)) { try { await L.redis(["EXPIREAT", qKey(trip.id), String(exp)]); } catch (e) { /* best effort */ } }
      if (turnUid) {
        await L.notify([turnUid], { k: "queue_turn", t: trip.id, tn: trip.name });
      }
      return { q, ok: true, changed: true };
    }
  }
  return { error: "busy" };
}

// seats.js: null = may book / hold; otherwise the error body to send (organizers always may)
async function gate(trip, user, isOwner) {
  if (!flagOn() || isOwner) return null;
  const { q } = await read(trip.id);
  if (!q.on) return null;
  const h = turnOf(q);
  if (user && h && h.u === user.id) return null;
  return { error: "not_your_turn" };
}

// seats.js after a booking: the turn ends by itself once the person holds as many seats as one person may
async function afterBook(trip, user, mineN) {
  if (!flagOn()) return;
  const limit = L.maxPerPerson(trip);
  if (!(limit > 0) || mineN < limit) return;
  await update(trip, (q) => { const h = turnOf(q); if (!h || h.u !== user.id) return false; h.done = 1; });
}

// where this visitor stands: {s: "out" (no name claimed) | "wait" (claimed, not their turn yet, or not approved) | "turn" | "done", ahead: people still before them}
function stateOf(q, user) {
  const mine = user ? q.items.find((i) => i.u === user.id) : null;
  if (!mine) return { s: "out" };
  if (mine.done) return { s: "done" };
  const h = turnOf(q);
  if (h && h.id === mine.id) return { s: "turn" };
  const idx = q.items.indexOf(mine);
  return { s: "wait", ahead: q.items.slice(0, idx).filter((i) => !i.done).length, ok: !!mine.ok };
}

module.exports = { stateOf, MAX_ITEMS, flagOn, qKey, head, turnOf, read, update, gate, afterBook };
