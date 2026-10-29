/* In-app notifications: bell with unread badge + list sheet. Shared by the home, booking and my-trips pages.
   VSBBell.mount(hostElement)          adds the bell button (hidden until a signed-in inbox loads)
   VSBBell.load()  -> Promise<items>   fetches /api/me?inbox=1 (re-renders the badge)
   VSBBell.onChange(fn)                fn(items) after every load / read
   VSBBell.forTrip(t)                  unread items of one trip
   VSBBell.text(item)                  { title, body, tone, icon } (Thai)
   VSBBell.tag(item)                   short label for a card badge
   VSBBell.read(sel)                   sel = "all" | { t } | { id } */
(function () {
  "use strict";
  var MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  var CSS = [
    ".vb-bell{position:relative;flex:none;width:36px;height:36px;border-radius:50%;background:#fff;border:1px solid #c9d2d8;display:inline-grid;place-items:center;color:#1b1f22;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}",
    ".vb-bell[hidden]{display:none}",
    ".vb-bell svg{width:18px;height:18px}",
    ".vb-bell .vb-n{position:absolute;top:-5px;right:-6px;min-width:19px;height:19px;padding:0 5px;border-radius:99px;background:#b3261e;color:#fff;font:600 11px/15px 'Noto Sans Thai',system-ui,sans-serif;text-align:center;border:2px solid #eef1f3;box-sizing:border-box}",
    ".vb-bell .vb-n[hidden]{display:none}",
    ".vb-bd{position:fixed;inset:0;z-index:60;background:rgba(27,31,34,.4);display:flex;align-items:flex-end;justify-content:center}",
    ".vb-sh{width:100%;max-width:460px;max-height:86vh;max-height:86dvh;overflow-y:auto;background:#fff;border-radius:24px 24px 0 0;padding:10px 16px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;font-family:'Noto Sans Thai',system-ui,sans-serif;color:#1b1f22;box-sizing:border-box}",
    ".vb-grab{width:40px;height:5px;border-radius:9px;background:#d5dce0;margin:0 auto 4px}",
    ".vb-hd{display:flex;justify-content:space-between;align-items:baseline;gap:10px}",
    ".vb-hd b{font:600 19px 'Prompt','Noto Sans Thai',sans-serif}",
    ".vb-hd button{border:0;background:none;padding:4px 0;font:600 13px 'Noto Sans Thai',sans-serif;color:#0e7c86;cursor:pointer}",
    ".vb-hd button:disabled{color:#9aa6ad}",
    ".vb-grp{font-weight:600;font-size:12px;color:#5f6b73;margin-top:4px}",
    ".vb-it{display:flex;gap:10px;padding:10px;border-radius:16px;position:relative;text-align:left;border:0;background:none;width:100%;font:inherit;color:inherit;cursor:pointer}",
    ".vb-it.new{background:#f5fafb}",
    ".vb-ic{flex:none;width:36px;height:36px;border-radius:12px;display:grid;place-items:center}",
    ".vb-ic svg{width:18px;height:18px}",
    ".t-amber{background:#fdf0dd;color:#b86e00}.t-teal{background:#e3f3f4;color:#0b5f67}.t-red{background:#fbe9e7;color:#b3261e}.t-grey{background:#eef1f3;color:#5f6b73}.t-green{background:#e8f8ee;color:#068c3f}",
    ".vb-tx{flex:1;min-width:0;font-size:13px;line-height:1.45;color:#5f6b73;padding-right:12px}",
    ".vb-tx b{display:block;color:#1b1f22;font-size:14px;font-weight:600}",
    ".vb-tx em{font-style:normal;color:#1b1f22;font-weight:600}",
    ".vb-tx small{display:block;font-size:11.5px;color:#8a979e;margin-top:1px}",
    ".vb-dot{position:absolute;right:10px;top:14px;width:8px;height:8px;border-radius:50%;background:#b3261e}",
    ".vb-empty{text-align:center;color:#5f6b73;font-size:14px;padding:28px 8px}",
    ".vb-ft{font-size:12px;color:#5f6b73;text-align:center;margin-top:6px}",
    ".vb-close{height:46px;border-radius:16px;border:1.5px solid #c9d2d8;background:#fff;font:600 15px 'Noto Sans Thai',sans-serif;color:#1b1f22;margin-top:6px;cursor:pointer}"
  ].join("\n");
  var IC = {
    bell: '<path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 004 0"/>',
    clock: '<path d="M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 7.5V12l3 2"/>',
    cal: '<path d="M6.5 5.5h11A2.5 2.5 0 0120 8v9.5a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5V8a2.5 2.5 0 012.5-2.5zM4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 10-13 0c0 5.4 6.5 11 6.5 11zM12 7.7a2.3 2.3 0 100 4.6 2.3 2.3 0 000-4.6z"/>',
    move: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
    pen: '<path d="M4 20h4l10-10-4-4L4 16v4zM13.5 6.5l4 4"/>',
    trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.4-3 7.7-7 9.5-4-1.8-7-5.1-7-9.5V6l7-3zM8.8 12l2.2 2.2 4.2-4.4"/>',
    edit: '<path d="M4 6h16M4 12h10M4 18h7"/>'
  };
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function day(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? (+m[3]) + " " + MON[+m[2] - 1] : ""; }
  function dates(p) { var a = day(p && p[0]), b = day(p && p[1]); return a ? (b && b !== a ? a + " – " + b : a) : "ไม่ระบุวัน"; }
  function tm(s) { return s ? String(s).replace(":", ".") + " น." : "ไม่ระบุ"; }
  function when(ts) {
    var d = Date.now() - ts, m = Math.floor(d / 60000);
    if (m < 1) return "เมื่อสักครู่";
    if (m < 60) return m + " นาทีก่อน";
    var h = Math.floor(m / 60); if (h < 24) return h + " ชั่วโมงก่อน";
    var x = new Date(ts + 7 * 3600e3), hm = String(x.getUTCHours()).padStart(2, "0") + "." + String(x.getUTCMinutes()).padStart(2, "0") + " น.";
    if (h < 48) return "เมื่อวาน " + hm;
    if (h < 24 * 7) return Math.floor(h / 24) + " วันก่อน";
    return x.getUTCDate() + " " + MON[x.getUTCMonth()] + " · " + hm;
  }
  function byTxt(it) { return it.by === "helper" ? " · โดยผู้ช่วยจัด" : it.by === "owner" ? " · โดยผู้จัด" : ""; }
  var FIELD = { name: ["เปลี่ยนชื่อทริป", "edit"], date: ["เปลี่ยนวันเดินทาง", "cal"], time: ["เปลี่ยนเวลารถออก", "clock"], meet: ["เปลี่ยนจุดนัดพบ", "pin"] };
  function chLine(c) {
    if (c.f === "date") return esc(dates(c.o)) + " → <em>" + esc(dates(c.n)) + "</em>";
    if (c.f === "time") return esc(tm(c.o)) + " → <em>" + esc(tm(c.n)) + "</em>";
    return esc(c.o || "ไม่ระบุ") + " → <em>" + esc(c.n || "ไม่ระบุ") + "</em>";
  }
  // title / body (HTML, escaped) / tone / icon for one notification
  function text(it) {
    var tn = esc(it.tn || "ทริป");
    switch (it.k) {
      case "trip_changed": {
        var ch = it.ch || [];
        if (ch.length === 1) return { title: FIELD[ch[0].f][0], body: tn + " · " + chLine(ch[0]), tone: "amber", icon: FIELD[ch[0].f][1] };
        return { title: "ทริปมีการเปลี่ยนแปลง", body: tn + "<br>" + ch.map(function (c) { return FIELD[c.f][0].replace("เปลี่ยน", "") + ": " + chLine(c); }).join("<br>"), tone: "amber", icon: "edit" };
      }
      case "trip_deleted": return { title: "ทริปถูกยกเลิก", body: tn + " · ผู้จัดลบทริปนี้แล้ว", tone: "red", icon: "trash" };
      case "van_removed": return { title: "คันรถที่คุณจองถูกลบ", body: tn + " · คัน " + esc(it.vl) + " · ที่นั่งของคุณถูกยกเลิก", tone: "red", icon: "trash" };
      case "seat_moved": return { title: "ที่นั่งของคุณถูกย้าย", body: tn + " · คัน " + esc(it.fvl) + " ที่ " + it.fs + " → <em>คัน " + esc(it.tvl) + " ที่ " + it.ts + "</em>", tone: "teal", icon: "move" };
      case "seat_cancelled": return { title: "ผู้จัดยกเลิกที่นั่งของคุณ", body: tn + " · คัน " + esc(it.vl) + " ที่ " + it.s, tone: "red", icon: "trash" };
      case "seat_renamed": return { title: "ชื่อบนผังถูกแก้", body: tn + " · " + esc(it.o) + " → <em>" + esc(it.n) + "</em>", tone: "grey", icon: "pen" };
      case "became_owner": return { title: "คุณเป็นเจ้าของทริปแล้ว", body: tn + (it.n ? " · " + esc(it.n) + " โอนทริปให้คุณ" : ""), tone: "green", icon: "shield" };
      case "removed_team": return { title: "คุณถูกนำออกจากทีมผู้จัด", body: tn, tone: "grey", icon: "shield" };
      case "helper_joined": return { title: "มีผู้ช่วยจัดเข้าร่วม", body: tn + " · " + esc(it.n), tone: "green", icon: "shield" };
      default: return { title: "มีการเปลี่ยนแปลง", body: tn, tone: "grey", icon: "bell" };
    }
  }
  function tag(it) {
    if (it.k === "trip_changed") { var ch = it.ch || []; if (ch.length !== 1) return "ทริปมีการเปลี่ยนแปลง"; var c = ch[0]; return c.f === "time" ? "เวลาเปลี่ยน · " + tm(c.n) : c.f === "date" ? "วันเดินทางเปลี่ยน" : c.f === "meet" ? "จุดนัดพบเปลี่ยน" : "ชื่อทริปเปลี่ยน"; }
    return { seat_moved: "ย้ายที่นั่งแล้ว", seat_renamed: "ชื่อบนผังถูกแก้", became_owner: "คุณเป็นเจ้าของแล้ว", helper_joined: "มีผู้ช่วยใหม่" }[it.k] || "";
  }
  var linkable = { trip_deleted: 0, removed_team: 0 };

  var B = { items: [], unread: 0, btn: null, ready: false, subs: [] };
  function injectCss() { if (document.getElementById("vb-css")) return; var st = document.createElement("style"); st.id = "vb-css"; st.textContent = CSS; document.head.appendChild(st); }
  function paint() {
    if (!B.btn) return;
    B.btn.hidden = !B.ready;
    var n = B.btn.querySelector(".vb-n"); n.textContent = B.unread > 99 ? "99+" : String(B.unread); n.hidden = !B.unread;
    B.btn.setAttribute("aria-label", "การแจ้งเตือน" + (B.unread ? " ยังไม่อ่าน " + B.unread + " รายการ" : ""));
  }
  function emit() { B.subs.forEach(function (f) { try { f(B.items); } catch (e) {} }); }
  B.mount = function (host) {
    injectCss();
    var b = document.createElement("button"); b.type = "button"; b.className = "vb-bell"; b.hidden = true;
    b.innerHTML = svg(IC.bell) + '<span class="vb-n" hidden></span>';
    b.addEventListener("click", function (e) { e.preventDefault(); B.open(); });
    host.appendChild(b); B.btn = b; paint();
    return b;
  };
  B.load = function () {
    return fetch("/api/me?inbox=1", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) { B.ready = false; B.items = []; B.unread = 0; } else { B.ready = true; B.items = d.items || []; B.unread = d.unread || 0; }
      paint(); emit(); return B.items;
    }).catch(function () { return B.items; });
  };
  B.onChange = function (f) { B.subs.push(f); };
  B.forTrip = function (t) { return B.items.filter(function (x) { return !x.r && x.t === t; }); };
  B.text = text; B.tag = tag; B.when = when;
  B.read = function (sel) {
    B.items.forEach(function (x) { if (!x.r && (sel === "all" || (sel.t && x.t === sel.t) || (sel.id && x.id === sel.id))) x.r = 1; });
    B.unread = B.items.filter(function (x) { return !x.r; }).length; paint(); emit();
    return fetch("/api/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ read: sel }) }).catch(function () {});
  };
  B.open = function () {
    injectCss();
    var bd = document.createElement("div"); bd.className = "vb-bd";
    var sh = document.createElement("div"); sh.className = "vb-sh"; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-label", "การแจ้งเตือน"); bd.appendChild(sh);
    function close() { bd.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
    function draw() {
      sh.innerHTML = "";
      sh.insertAdjacentHTML("beforeend", '<div class="vb-grab"></div><div class="vb-hd"><b>การแจ้งเตือน</b><button type="button" class="vb-all"' + (B.unread ? "" : " disabled") + ">อ่านทั้งหมด</button></div>");
      sh.querySelector(".vb-all").addEventListener("click", function () { B.read("all"); draw(); });
      if (!B.items.length) sh.insertAdjacentHTML("beforeend", '<div class="vb-empty">ยังไม่มีการแจ้งเตือน<br>ถ้าผู้จัดเปลี่ยนเวลา ย้ายที่นั่ง หรือยกเลิกทริป จะแจ้งที่นี่</div>');
      var groups = [["ใหม่", B.items.filter(function (x) { return !x.r; })], ["ก่อนหน้านี้", B.items.filter(function (x) { return x.r; })]];
      groups.forEach(function (g) {
        if (!g[1].length) return;
        sh.insertAdjacentHTML("beforeend", '<div class="vb-grp">' + g[0] + "</div>");
        g[1].forEach(function (it) {
          var tx = text(it), b = document.createElement("button"); b.type = "button"; b.className = "vb-it" + (it.r ? "" : " new");
          b.innerHTML = '<div class="vb-ic t-' + tx.tone + '">' + svg(IC[tx.icon] || IC.bell) + '</div><div class="vb-tx"><b>' + tx.title + "</b>" + tx.body + "<small>" + when(it.at) + byTxt(it) + "</small></div>" + (it.r ? "" : '<span class="vb-dot"></span>');
          b.addEventListener("click", function () {
            B.read({ id: it.id });
            if (it.t && !(it.k in linkable) && location.pathname !== "/" + it.t) location.href = "/" + it.t; else { close(); }
          });
          sh.appendChild(b);
        });
      });
      sh.insertAdjacentHTML("beforeend", '<div class="vb-ft">เก็บการแจ้งเตือนล่าสุด 50 รายการ · ลบเองหลัง 60 วัน</div><button type="button" class="vb-close">ปิด</button>');
      sh.querySelector(".vb-close").addEventListener("click", close);
    }
    draw();
    document.body.appendChild(bd);
    B.load().then(function () { if (bd.isConnected) draw(); });
  };
  window.VSBBell = B;
})();
