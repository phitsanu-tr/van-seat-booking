#!/usr/bin/env node
// Backup the whole Upstash database to one JSON file (run from your own computer):
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/dump.js
// Writes backup-YYYY-MM-DD-HHMM.json in the current folder. The file holds personal data —
// keep it somewhere safe, and delete old copies you no longer need.
const fs = require("fs");
const URL0 = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!URL0 || !TOKEN) { console.error("set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first"); process.exit(1); }
async function redis(cmd) {
  const r = await fetch(URL0, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
(async () => {
  const keys = [];
  let cur = "0";
  do {
    const [next, batch] = await redis(["SCAN", cur, "COUNT", "500"]);
    cur = next; keys.push(...batch);
  } while (cur !== "0");
  keys.sort();
  console.log(keys.length + " keys");
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    const types = await Promise.all(part.map((k) => redis(["TYPE", k])));
    const vals = await Promise.all(part.map((k, j) => {
      const t = types[j];
      return t === "string" ? redis(["GET", k]) : t === "hash" ? redis(["HGETALL", k]) : t === "set" ? redis(["SMEMBERS", k])
        : t === "list" ? redis(["LRANGE", k, "0", "-1"]) : t === "zset" ? redis(["ZRANGE", k, "0", "-1", "WITHSCORES"]) : null;
    }));
    const ttls = await Promise.all(part.map((k) => redis(["TTL", k])));
    part.forEach((k, j) => { out[k] = { type: types[j], ttl: ttls[j], value: vals[j] }; });
    process.stdout.write("\r" + Math.min(i + 50, keys.length) + "/" + keys.length);
  }
  const name = "backup-" + new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", "-").replace(":", "") + ".json";
  fs.writeFileSync(name, JSON.stringify({ at: Date.now(), keys: keys.length, data: out }, null, 1));
  console.log("\nwrote " + name);
})().catch((e) => { console.error(e.message); process.exit(1); });
