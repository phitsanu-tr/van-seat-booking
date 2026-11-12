// Vercel serverless function: /api/pay — packages and payments (Stripe Checkout: PromptPay QR or card)
//   GET                     -> { on, plan, catalog, open, ready }       the signed-in account's package (+ what it uses now)
//   GET  ?orders=1          -> { orders }                              payment history
//   POST { sku }            -> { order, url }                          start a payment: url = Stripe's checkout page
//   GET  ?order=<id>        -> { order }                               status (asks Stripe when still open; grants once paid)
//   POST ?hook=1            Stripe webhook, signed with STRIPE_WEBHOOK_SECRET: checkout.session.completed / async_payment_succeeded
//                           grant the order; charge.refunded (full refund) takes it back
//   POST { order, devPaid } local dev only: pretend the payment went through
// Env: STRIPE_SECRET_KEY (sk_...), STRIPE_WEBHOOK_SECRET (whsec_...), PLANS_ON=1 to switch packages on in production.
// The customer pays Stripe (their bank app shows "STRIPE PAYMENTS (THAILAND) LTD"), never the app owner's own account.
const L = require("./_lib");
const P = require("./_plans");

const DEV = process.env.VSB_DEV_AUTH === "1" && !process.env.VERCEL;
const ORDER_DAYS = 400;
function stripeKey() { const k = process.env.STRIPE_SECRET_KEY || ""; return /^sk_(test|live)_/.test(k) ? k : ""; }

function form(obj, prefix, out) { // nested object -> Stripe's form encoding (a[b][0]=c)
  out = out || [];
  Object.keys(obj).forEach((k) => {
    const v = obj[k], name = prefix ? prefix + "[" + k + "]" : k;
    if (v === undefined || v === null) return;
    if (typeof v === "object") form(v, name, out); else out.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(v)));
  });
  return out.join("&");
}
async function stripe(method, path, body) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method, headers: { Authorization: "Bearer " + stripeKey(), "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? form(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("stripe_" + r.status + ":" + ((d.error && d.error.code) || ""));
  return d;
}

function origin(req) {
  const host = String((req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "").split(",")[0].trim();
  return (L.isHttps(req) ? "https://" : "http://") + host;
}
async function loadOrder(id) { try { return JSON.parse(L.open(await L.redis(["GET", "order:" + id]))); } catch (e) { return null; } }
async function saveOrder(o) { await L.redis(["SET", "order:" + o.id, L.seal(JSON.stringify(o)), "EX", String(ORDER_DAYS * 86400)]); }
const REFUND_DAYS = 7; // every package and pass: a refund can be asked for within 7 days of paying (terms, section 4)
const REFUND_WHY = ["cant_use", "duplicate", "not_needed", "other"];
function refundUntil(o) { return (o.paidAt || o.at || 0) + REFUND_DAYS * 86400 * 1000; }
function publicOrder(o) {
  return { id: o.id, sku: o.sku, label: (P.SKUS[o.sku] || {}).label || o.sku, amount: o.amount, status: o.status, at: o.at, paidAt: o.paidAt || 0,
    refundReq: !!o.refundReq, refundUntil: refundUntil(o), canRefund: o.status === "paid" && !o.refundReq && Date.now() <= refundUntil(o) };
}

// marks the order paid and adds the package / pass — exactly once, however many times Stripe or the page reports it
async function fulfil(o) {
  const first = await L.redis(["SET", "orderdone:" + o.id, "1", "NX", "EX", String(ORDER_DAYS * 86400)]);
  if (first !== "OK") return (await loadOrder(o.id)) || o;
  try { await P.grant(o.uid, o.sku, "paid"); } catch (e) { await L.redis(["DEL", "orderdone:" + o.id]); throw e; } // let the next check try again
  const next = Object.assign({}, o, { status: "paid", paidAt: Date.now() });
  await saveOrder(next);
  if (o.pi) { try { await L.redis(["SET", "orderpi:" + o.pi, o.id, "EX", String(ORDER_DAYS * 86400)]); } catch (e) { /* best effort */ } } // refunds find the order by it
  const s = P.SKUS[o.sku] || {};
  await L.notify([o.uid], { k: "plan_paid", tn: s.label || "", amt: o.amount });
  return next;
}
async function refresh(o) { // asks Stripe whether an open order has been paid
  if (!o || o.status !== "open" || !o.sess || !stripeKey()) return o;
  try {
    const s = await stripe("GET", "checkout/sessions/" + encodeURIComponent(o.sess));
    if (s.payment_status === "paid") return await fulfil(Object.assign({}, o, { pi: s.payment_intent || o.pi }));
    if (s.status === "expired") { const next = Object.assign({}, o, { status: "expired" }); await saveOrder(next); return next; }
  } catch (e) { /* keep it open */ }
  return o;
}

function readRaw(req) { // the exact bytes Stripe signed (Vercel only parses req.body when it is read)
  return new Promise((resolve) => {
    if (typeof req.rawBody === "string") return resolve(req.rawBody);
    let b = ""; req.setEncoding && req.setEncoding("utf8");
    req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); req.on("error", () => resolve(""));
  });
}
function signedOk(raw, header, secret) {
  const parts = {}; String(header || "").split(",").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) (parts[kv.slice(0, i)] = parts[kv.slice(0, i)] || []).push(kv.slice(i + 1)); });
  const t = (parts.t || [])[0]; if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const want = L.crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return (parts.v1 || []).some((v) => v.length === want.length && L.crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
}

// one line under the product name on Stripe's page
function descOf(s) {
  if (s.kind === "pass") return "สร้างทริปได้ 1 ทริป · ไม่มีวันหมดอายุ";
  const t = P.TIERS[s.tier];
  return (t.trips ? t.trips + " ทริป/เดือน" : "ทริปไม่จำกัด") + " · รถ " + t.vans + " คัน · ใช้ได้ " + s.days + " วัน";
}

module.exports = async function handler(req, res) {
  if (!L.REST_URL || !L.REST_TOKEN) return L.json(res, 500, { error: "not_configured" });
  const q = req.query || {};
  try {
    if (req.method === "POST" && q.hook !== undefined) {
      const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
      const raw = await readRaw(req);
      if (!secret || !signedOk(raw, req.headers["stripe-signature"], secret)) return L.json(res, 400, { error: "bad_signature" });
      let ev = null; try { ev = JSON.parse(raw); } catch (e) { ev = null; }
      const obj = ev && ev.data && ev.data.object;
      if (ev && obj && (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && obj.payment_status === "paid") {
        const id = obj.metadata && obj.metadata.order;
        const o = /^[a-z0-9]{12}$/.test(id || "") ? await loadOrder(id) : null;
        if (o && o.sess === obj.id) await fulfil(Object.assign({}, o, { pi: obj.payment_intent || o.pi }));
      }
      if (ev && obj && ev.type === "charge.refunded" && obj.refunded === true && obj.payment_intent) {
        const id = await L.redis(["GET", "orderpi:" + obj.payment_intent]);
        const o = /^[a-z0-9]{12}$/.test(id || "") ? await loadOrder(id) : null;
        if (o && o.status === "paid" && (await L.redis(["SET", "orderref:" + o.id, "1", "NX", "EX", String(ORDER_DAYS * 86400)])) === "OK") {
          await P.revoke(o.uid, o.sku);
          await saveOrder(Object.assign({}, o, { status: "refunded", refundedAt: Date.now() }));
          await L.notify([o.uid], { k: "plan_refunded", tn: (P.SKUS[o.sku] || {}).label || "", amt: o.amount });
        }
      }
      return L.json(res, 200, { received: true });
    }

    if (L.crossSite(req)) return L.json(res, 403, { error: "cross_site" });
    const user = await L.currentUser(req);
    if (!user) return L.json(res, 401, { error: "login_required" });

    if (req.method === "GET" && q.orders !== undefined) {
      const ids = ((await L.redis(["LRANGE", "orders:" + user.id, "0", "49"])) || []).filter((x) => /^[a-z0-9]{12}$/.test(x));
      const raws = ids.length ? await L.pipeline(ids.map((id) => ["GET", "order:" + id])) : [];
      const orders = [];
      raws.forEach((r) => { try { const o = JSON.parse(L.open(r)); if (o && o.uid === user.id && (o.status === "paid" || o.status === "refunded")) orders.push(publicOrder(o)); } catch (e) { /* skip */ } });
      return L.json(res, 200, { orders });
    }
    if (req.method === "GET" && q.order !== undefined) {
      const id = String(q.order);
      let o = /^[a-z0-9]{12}$/.test(id) ? await loadOrder(id) : null;
      if (!o || o.uid !== user.id) return L.json(res, 404, { error: "no_order" });
      o = await refresh(o);
      const plan = await P.getPlan(user.id);
      return L.json(res, 200, { order: publicOrder(o), plan: P.publicPlan(plan) });
    }
    if (req.method === "GET") {
      const plan = await P.getPlan(user.id);
      const used = plan.on ? await P.monthUsed(user.id) : 0;
      const catalog = Object.keys(P.SKUS).map((k) => Object.assign({ sku: k }, P.SKUS[k], P.priceOf(k)));
      return L.json(res, 200, { on: plan.on, ready: !!stripeKey() || DEV, dev: DEV, plan: P.publicPlan(plan, { used }), tiers: P.TIERS, catalog, promoEnd: P.promoOn() ? P.PROMO_END : 0 });
    }

    if (req.method === "POST") {
      const body = L.readBody(req);
      if (body && body.refund) { // the buyer asks for a refund; the owner decides and refunds in Stripe (the webhook then takes the package back)
        const r = body.refund;
        const o = /^[a-z0-9]{12}$/.test(String(r.order || "")) ? await loadOrder(String(r.order)) : null;
        if (!o || o.uid !== user.id) return L.json(res, 404, { error: "no_order" });
        if (await L.rateLimited(req, user, "refund", 5, 3600)) return L.json(res, 429, { error: "too_many" });
        if (o.status !== "paid") return L.json(res, 409, { error: "not_paid" });
        if (o.refundReq) return L.json(res, 409, { error: "already" });
        if (Date.now() > refundUntil(o)) return L.json(res, 409, { error: "too_late" });
        const why = REFUND_WHY.indexOf(r.why) >= 0 ? r.why : "other";
        const note = String(r.note || "").replace(/\s+/g, " ").trim().slice(0, 300);
        await saveOrder(Object.assign({}, o, { refundReq: { at: Date.now(), why, note } }));
        try { const w = (await L.redis(["SMEMBERS", "owner:watch"])) || []; if (w.length) { const lbl = (P.SKUS[o.sku] || {}).label || ""; await L.notify(w, { k: "refund_req", tn: lbl, amt: o.amount, n: why }); await L.linePush(w, "VanTrip: มีคำขอคืนเงินใหม่\n" + lbl + " · " + o.amount + " บาท\nตรวจที่หน้า /owner"); } } catch (e) { /* best effort */ }
        return L.json(res, 200, { ok: true });
      }
      if (DEV && body.devPaid === true) { // local dev: no Stripe, finish the order right away
        const o = /^[a-z0-9]{12}$/.test(String(body.order || "")) ? await loadOrder(String(body.order)) : null;
        if (!o || o.uid !== user.id) return L.json(res, 404, { error: "no_order" });
        return L.json(res, 200, { order: publicOrder(await fulfil(o)) });
      }
      if (!(await P.getPlan(user.id)).on) return L.json(res, 403, { error: "plans_off" });
      const s = Object.prototype.hasOwnProperty.call(P.SKUS, body.sku) ? P.SKUS[body.sku] : null;
      if (!s) return L.json(res, 400, { error: "bad_sku" });
      if (!stripeKey() && !DEV) return L.json(res, 503, { error: "pay_not_ready" });
      if (await L.rateLimited(req, user, "pay", 20, 3600)) return L.json(res, 429, { error: "too_many" });
      const pr = P.priceOf(body.sku);
      const o = { id: L.newId(12), uid: user.id, name: user.name, sku: body.sku, amount: pr.amount, status: "open", at: Date.now() };
      let url = "";
      if (stripeKey()) {
        const back = origin(req) + "/plans?order=" + o.id;
        const sess = await stripe("POST", "checkout/sessions", {
          mode: "payment", payment_method_types: ["promptpay", "card"], locale: "th",
          line_items: [{ quantity: 1, price_data: { currency: "thb", unit_amount: pr.amount * 100, product_data: { name: s.label, description: descOf(s), images: [origin(req) + "/pay-icon.png"] } } }],
          success_url: back, cancel_url: back + "&c=1", client_reference_id: o.id, metadata: { order: o.id, sku: body.sku },
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        });
        o.sess = sess.id; url = sess.url;
      } else url = "/plans?order=" + o.id + "&dev=1";
      await saveOrder(o);
      await L.pipeline([["LPUSH", "orders:" + user.id, o.id], ["LTRIM", "orders:" + user.id, "0", "99"], ["EXPIRE", "orders:" + user.id, String(ORDER_DAYS * 86400)],
        ["LPUSH", "orders:all", o.id], ["LTRIM", "orders:all", "0", "999"]]);
      return L.json(res, 200, { order: publicOrder(o), url });
    }
    res.setHeader("Allow", "GET, POST");
    return L.json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.json(res, 502, { error: String(e.message || "").indexOf("stripe_") === 0 ? "pay_error" : "storage_error" });
  }
};
