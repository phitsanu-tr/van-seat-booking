// Vercel serverless function: GET / POST / DELETE /api/seats
// Storage: one Redis hash (field = seat number, value = JSON). Works with the
// Upstash Redis integration from the Vercel Marketplace (KV_REST_API_* variables)
// or a plain Upstash database (UPSTASH_REDIS_REST_* variables).

const crypto = require("crypto");

// Accept the variable names with or without a custom prefix (e.g. STORAGE_KV_REST_API_URL).
function pickEnv(...names) {
  for (const name of names) {
    for (const key of Object.keys(process.env)) {
      if ((key === name || key.endsWith("_" + name)) && process.env[key]) return process.env[key];
    }
  }
  return undefined;
}

const REST_URL = pickEnv("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
const REST_TOKEN = pickEnv("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");
const ADMIN_CODE = process.env.ADMIN_CODE || "";

const TOTAL_SEATS = 10;
const SEATS_KEY = "van:seats";
const FAIL_LIMIT = 8;       // wrong codes allowed per seat ...
const FAIL_WINDOW_SEC = 600; // ... within this many seconds

async function redisPipeline(commands) {
  const res = await fetch(REST_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const out = await res.json();
  if (!res.ok || !Array.isArray(out)) throw new Error("redis_http_" + res.status);
  return out.map((item) => {
    if (item && item.error) throw new Error(item.error);
    return item.result;
  });
}

async function redis(command) {
  return (await redisPipeline([command]))[0];
}

function hashPin(seat, pin) {
  return crypto.createHash("sha256").update(seat + ":" + pin).digest("hex");
}

function readBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b && typeof b === "object" ? b : {};
}

function parseSeat(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_SEATS ? n : null;
}

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) {
    return json(res, 500, { error: "not_configured" });
  }

  try {
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", SEATS_KEY])) || [];
      const seats = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const n = parseSeat(flat[i]);
        if (n === null) continue;
        try {
          const v = JSON.parse(flat[i + 1]);
          if (v && v.name) seats[n] = { name: String(v.name), at: v.at };
        } catch (e) { /* skip a damaged entry */ }
      }
      return json(res, 200, { seats });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const seat = parseSeat(body.seat);
      const name = String(body.name || "").trim().slice(0, 30);
      const pin = String(body.pin || "");
      if (seat === null) return json(res, 400, { error: "bad_seat" });
      if (!name) return json(res, 400, { error: "bad_name" });
      if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: "bad_pin" });

      const at = Date.now();
      const value = JSON.stringify({ name, h: hashPin(String(seat), pin), at });
      const created = await redis(["HSETNX", SEATS_KEY, String(seat), value]);
      if (created !== 1) return json(res, 409, { error: "taken" });
      return json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const body = readBody(req);
      const seat = parseSeat(body.seat);
      const code = String(body.code || "").slice(0, 64);
      if (seat === null) return json(res, 400, { error: "bad_seat" });
      if (!code) return json(res, 400, { error: "bad_code" });

      const failKey = "van:fail:" + seat;
      const [raw, fails] = await redisPipeline([["HGET", SEATS_KEY, String(seat)], ["GET", failKey]]);
      if (raw === null || raw === undefined) return json(res, 200, { ok: true });
      if (Number(fails || 0) >= FAIL_LIMIT) return json(res, 429, { error: "too_many_tries" });

      let stored = {};
      try { stored = JSON.parse(raw); } catch (e) { /* treat as no hash: only admin can remove */ }
      const isAdmin = ADMIN_CODE !== "" && code === ADMIN_CODE;
      const isOwner = !!stored.h && hashPin(String(seat), code) === stored.h;

      if (!isAdmin && !isOwner) {
        await redisPipeline([["INCR", failKey], ["EXPIRE", failKey, String(FAIL_WINDOW_SEC)]]);
        return json(res, 403, { error: "wrong_code" });
      }
      await redisPipeline([["HDEL", SEATS_KEY, String(seat)], ["DEL", failKey]]);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return json(res, 502, { error: "storage_error" });
  }
};
