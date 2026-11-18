/* Require the LINE Official Account (Van Trip) as a friend, so trip notices can reach the passenger in the LINE chat.
   Off unless the server says so: /api/auth?me=1 returns friend:{need:true,url} only when REQUIRE_OA_FRIEND=1 is set.
   Needs the OA linked to the LINE Login channel (same provider); liff.getFriendship() then tells friendFlag.
   A friendship check that errors never blocks anyone: only an explicit friendFlag === false shows the screen. */
(function () {
  "use strict";
  var box = null, busy = false;
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function close() { if (box) { box.remove(); box = null; document.documentElement.style.overflow = ""; } }
  function ask() { return window.liff && liff.getFriendship ? liff.getFriendship().then(function (f) { return f ? f.friendFlag : null; }).catch(function () { return null; }) : Promise.resolve(null); }
  function show(url) {
    if (box) return;
    box = el("div", "vf-gate"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "vfT");
    var card = el("div", "vf-card");
    card.appendChild(el("div", "vf-ic", "🚐"));
    var h = el("h2", null, "เพิ่ม Van Trip เป็นเพื่อนก่อนใช้งาน"); h.id = "vfT"; card.appendChild(h);
    card.appendChild(el("p", "vf-lead", "เพื่อให้แจ้งเตือนคุณทางแชต LINE ได้ทันที"));
    var ul = el("ul", "vf-list");
    ["แจ้งเมื่อถึงลำดับเลือกที่นั่งของคุณ", "แจ้งเมื่อแอดมินยืนยันการชำระเงินแล้ว", "แจ้งเรื่องสำคัญของทริป เช่น เปลี่ยนเวลา จุดนัดพบ ยกเลิก"].forEach(function (t) { ul.appendChild(el("li", null, t)); });
    card.appendChild(ul);
    card.appendChild(el("p", "vf-note", "เราส่งเฉพาะข้อความที่เกี่ยวกับทริปที่คุณจอง ไม่ส่งโฆษณา และคุณบล็อกได้ทุกเมื่อ"));
    var warn = el("div", "vf-warn", "ยังไม่พบว่าเป็นเพื่อนกัน กดเพิ่มเพื่อนแล้วกลับมาที่นี่ หรือถ้าเคยบล็อกไว้ ให้ปลดบล็อก Van Trip ในแชตก่อน"); warn.hidden = true; warn.setAttribute("role", "status");
    card.appendChild(warn);
    var add = el("a", "vf-btn", "เพิ่ม Van Trip เป็นเพื่อน"); add.href = url; add.target = "_blank"; add.rel = "noopener";
    var chk = el("button", "vf-btn vf-o", "เพิ่มแล้ว · ตรวจสอบอีกครั้ง"); chk.type = "button";
    chk.addEventListener("click", function () {
      if (busy) return; busy = true; chk.disabled = true;
      ask().then(function (f) { busy = false; chk.disabled = false; if (f === false) warn.hidden = false; else close(); });
    });
    card.appendChild(add); card.appendChild(chk);
    box.appendChild(card); document.body.appendChild(box);
    document.documentElement.style.overflow = "hidden";
    chk.focus();
  }
  var url = "";
  function run() {
    if (!window.liff || !liff.isLoggedIn || !liff.isLoggedIn()) return;
    fetch("/api/auth?me=1", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (me) {
      if (!me || !me.user || !me.friend || !me.friend.need) return;
      url = me.friend.url;
      return ask().then(function (f) { if (f === false) show(url); });
    }).catch(function () { /* never block on an error */ });
  }
  var st = document.createElement("style");
  st.textContent = ".vf-gate{position:fixed;inset:0;z-index:2147483000;background:rgba(10,24,28,.72);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));overflow:auto}"
    + ".vf-card{background:var(--surface,#fff);color:var(--ink,#17262b);border-radius:20px;padding:24px 20px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px;font:15px/1.5 var(--font-body,system-ui,sans-serif)}"
    + ".vf-card h2{margin:0;text-align:center;font:700 19px/26px var(--font-display,inherit)}.vf-ic{width:64px;height:64px;border-radius:50%;background:var(--tint,#e4f2f3);font-size:30px;line-height:64px;text-align:center;margin:0 auto}"
    + ".vf-lead{margin:0;text-align:center;color:var(--muted,#5b6b72)}.vf-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14px}"
    + ".vf-note{margin:0;font-size:12.5px;color:var(--muted,#5b6b72);background:var(--tint,#e4f2f3);border-radius:12px;padding:10px 12px}"
    + ".vf-warn{font-size:13px;background:#fff4dc;color:#6b4a00;border:1px solid #efd49b;border-radius:12px;padding:10px 12px}"
    + ".vf-btn{display:block;text-align:center;text-decoration:none;font:600 15px/1.2 var(--font-body,inherit);border:0;border-radius:12px;padding:13px;background:var(--mine,#0e7c86);color:var(--mine-ink,#fff);cursor:pointer}"
    + ".vf-btn.vf-o{background:transparent;color:var(--mine,#0e7c86);border:1.5px solid var(--mine,#0e7c86)}.vf-btn:disabled{opacity:.5}";
  document.head.appendChild(st);
  function boot() {
    if (!window.liff) return;
    var go = function () { run(); document.addEventListener("visibilitychange", function () { if (!document.hidden && box) ask().then(function (f) { if (f !== false) close(); }); }); };
    if (liff.ready && liff.ready.then) liff.ready.then(go).catch(function () {}); else setTimeout(go, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
