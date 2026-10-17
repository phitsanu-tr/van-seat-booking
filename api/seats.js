// Vercel serverless function: GET / POST / DELETE /api/seats
// Storage: one Redis hash (field = seat number, value = JSON {name, at}).
// Works with the Upstash Redis integration from the Vercel Marketplace
// (KV_REST_API_* variables, with or without a custom prefix) or a plain
// Upstash database (UPSTASH_REDIS_REST_* variables).

const TOTAL_SEATS = 10;
const SEATS_KEY = "van:seats";

// Accept the variable names with or without a custom prefix (e.g. VAN_SEAT_BOOKING_KV_REST_API_URL).
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

async function redis(command) {
  const res = await fetch(REST_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify([command]),
  });
  const out = await res.json();
  if (!res.ok || !Array.isArray(out) || !out[0]) throw new Error("redis_http_" + res.status);
  if (out[0].error) throw new Error(out[0].error);
  return out[0].result;
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
      if (seat === null) return json(res, 400, { error: "bad_seat" });
      if (!name) return json(res, 400, { error: "bad_name" });

      const at = Date.now();
      // HSETNX only writes when the seat is still empty, so two people can never take the same seat.
      const created = await redis(["HSETNX", SEATS_KEY, String(seat), JSON.stringify({ name, at })]);
      if (created !== 1) return json(res, 409, { error: "taken" });
      return json(res, 200, { ok: true, at });
    }

    if (req.method === "DELETE") {
      const seat = parseSeat(readBody(req).seat);
      if (seat === null) return json(res, 400, { error: "bad_seat" });
      await redis(["HDEL", SEATS_KEY, String(seat)]);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return json(res, 502, { error: "storage_error" });
  }
};
