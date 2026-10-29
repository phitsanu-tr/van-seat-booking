// Shared bits for the browser tests in tests/e2e (see tests/README.md).
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8765;
const BASE = process.env.BASE || "http://localhost:" + PORT;
const OUT = path.join(__dirname, "out"); // screenshots land here (git-ignored)
fs.mkdirSync(OUT, { recursive: true });

// Playwright: tests/node_modules first (npm install in tests/), then a global install.
function find(mod) {
  try { return require.resolve(mod, { paths: [__dirname] }); } catch (e) { /* fall through */ }
  try { return require.resolve(mod); } catch (e) { return null; }
}
const PW = find("playwright") || "playwright";

// Chromium: PW_CHROMIUM if set, else a known preinstalled one, else Playwright's own download.
const pre = ["/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : pre ? { executablePath: pre } : {};

// Fonts: serve Prompt + Noto Sans Thai from @fontsource (npm install in tests/) so screenshots
// look like the real site without the network. Without them, Google Fonts is blanked out.
const TH = "U+0E01-0E5B, U+200C-200D, U+25CC";
const LA = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const FAM = [["Prompt", "prompt"], ["Noto Sans Thai", "noto-sans-thai"]];
const dirs = {};
for (const [, d] of FAM) { const p = find("@fontsource/" + d + "/package.json"); if (p) dirs[d] = path.dirname(p); }
let css = "";
for (const [fam, d] of FAM) if (dirs[d]) for (const w of [400, 500, 600]) for (const [sub, ur] of [["thai", TH], ["latin", LA]])
  css += `@font-face{font-family:'${fam}';font-weight:${w};font-style:normal;font-display:block;src:url(https://fonts.gstatic.com/x/${d}/${d}-${sub}-${w}-normal.woff2) format('woff2');unicode-range:${ur}}\n`;

async function fonts(ctx) {
  await ctx.route("**/fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: css }));
  await ctx.route("**/fonts.gstatic.com/x/**", (r) => {
    const [, , d, f] = new URL(r.request().url()).pathname.split("/");
    if (!dirs[d] || !/^[\w.-]+\.woff2$/.test(f)) return r.fulfill({ status: 404, body: "" });
    r.fulfill({ status: 200, contentType: "font/woff2", body: fs.readFileSync(path.join(dirs[d], "files", f)) });
  });
}

// A date n days from today (YYYY-MM-DD, local time), so trips in the tests never fall into the past.
function day(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

module.exports = { BASE, PORT, OUT, PW, launchOpts, fonts, day };
