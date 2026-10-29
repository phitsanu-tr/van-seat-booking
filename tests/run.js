#!/usr/bin/env node
// Runs the browser tests in tests/e2e against a fresh local dev server (node dev.js, fake Redis,
// fake LINE accounts) and compares what each test prints with tests/expected/<name>.txt.
//
//   node tests/run.js            run every test
//   node tests/run.js 05 08      run only tests whose file name starts with 05 or 08
//   node tests/run.js --update   save the current output as the new expected output
//
// In an expected file, {a..b} matches any whole number from a to b (for timing-based counts).
// Trip ids and timestamps are masked before comparing, so they may differ from run to run.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(__dirname, "e2e");
const EXP = path.join(__dirname, "expected");
const PORT = Number(process.env.PORT) || 8765;
const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => !a.startsWith("--"));
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".js") && (!only.length || only.some((o) => f.startsWith(o)))).sort();

const mask = (s) => s
  .replace(/\b1[6-9]\d{11}\b/g, "<ts>") // millisecond timestamps
  .replace(/([/#])[a-z0-9]{8}(?=[-?&\s"]|$)/gm, "$1<id>") // trip ids in urls
  .replace(/\r/g, "").trimEnd();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function lineMatches(exp, got) {
  if (exp === got) return true;
  const ranges = [];
  const re = new RegExp("^" + exp.split(/\{(\d+)\.\.(\d+)\}/).map((part, i) => {
    if (i % 3 === 0) return esc(part);
    if (i % 3 === 1) ranges.push([Number(part)]); else ranges[ranges.length - 1].push(Number(part));
    return i % 3 === 1 ? "(\\d+)" : "";
  }).join("") + "$");
  const m = re.exec(got);
  return !!m && ranges.every(([a, b], i) => Number(m[i + 1]) >= a && Number(m[i + 1]) <= b);
}

const portFree = () => new Promise((res) => { const s = net.connect(PORT, "127.0.0.1"); s.on("connect", () => { s.end(); res(false); }); s.on("error", () => res(true)); });
const portUp = async () => { for (let i = 0; i < 50; i++) { if (!(await portFree())) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

function run(cmd, argv, env, timeoutMs) {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: Object.assign({}, process.env, env) });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { out += "\n[timed out]"; p.kill("SIGKILL"); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); res({ code, out }); });
  });
}

(async () => {
  if (!(await portFree())) { console.error(`Port ${PORT} is in use. Stop the running dev server first (or set PORT).`); process.exit(2); }
  fs.mkdirSync(EXP, { recursive: true });
  let failed = 0;
  for (const f of files) {
    const name = f.replace(/\.js$/, "");
    // a fresh server per test: the fake Redis lives in memory, so every test starts empty
    const server = spawn(process.execPath, ["dev.js"], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), OWNER_KEY: "test-owner-key-1234567" }), stdio: "ignore" });
    const t0 = Date.now();
    let r;
    if (!(await portUp())) r = { code: 1, out: "[dev server did not start]" };
    else r = await run(process.execPath, [path.join(DIR, f)], { PORT: String(PORT) }, 240000);
    server.kill();
    await new Promise((res) => server.on("close", res));
    const got = mask(r.out);
    const sec = ((Date.now() - t0) / 1000).toFixed(0) + "s";
    const expFile = path.join(EXP, name + ".txt");
    const problems = [];
    if (r.code !== 0) problems.push("exit code " + r.code);
    const errLine = got.split("\n").find((l) => l.startsWith("ERR "));
    if (errLine !== "ERR []") problems.push("page errors: " + (errLine || "no ERR line"));
    if (update && !problems.length) { fs.writeFileSync(expFile, got + "\n"); console.log(`✎ ${name} (${sec}) expected output saved`); continue; }
    if (!fs.existsSync(expFile)) problems.push("no expected file (run with --update)");
    else {
      const exp = mask(fs.readFileSync(expFile, "utf8")).split("\n"), g = got.split("\n");
      for (let i = 0; i < Math.max(exp.length, g.length); i++) {
        if (!lineMatches(exp[i] || "", g[i] || "")) { problems.push(`line ${i + 1}\n    expected: ${exp[i] || "(nothing)"}\n    got:      ${g[i] || "(nothing)"}`); if (problems.length > 4) break; }
      }
    }
    if (problems.length) { failed++; console.log(`✗ ${name} (${sec})\n  ` + problems.join("\n  ")); if (r.code !== 0) console.log(r.out.split("\n").slice(-12).join("\n")); }
    else console.log(`✓ ${name} (${sec})`);
  }
  console.log(failed ? `\n${failed} of ${files.length} failed` : `\nall ${files.length} passed · screenshots in tests/out/`);
  process.exit(failed ? 1 : 0);
})();
