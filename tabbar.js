/* Bottom menu (5 tabs) for the pages that sit outside /mytrips: trips form, plans, privacy, booking.
   Shown only when signed in. <script src="/tabbar.js" data-tab="trips|seats|acct"></script>
   Same look as the tab bar inside /mytrips (kept in sync by hand). */
(function () {
  "use strict";
  var me = document.currentScript, active = (me && me.getAttribute("data-tab")) || "";
  var P = {
    home: '<path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    trips: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    seats: '<path d="M8 3h4a2 2 0 012 2v6a2 2 0 01-2 2H9.5a2 2 0 01-2-1.7L6 5a2 2 0 012-2z"/><path d="M7 16h11a2 2 0 010 4H7z"/>',
    notif: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'
  };
  function icon(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[k] + "</svg>"; }
  var css =
    ".vt-bar{transform:translateZ(0);will-change:transform;position:fixed;left:0;right:0;bottom:0;padding:6px max(0px,calc((100% - 460px) / 2)) max(8px,env(safe-area-inset-bottom));background:#fff;display:flex;justify-content:space-around;align-items:flex-start;z-index:15;box-shadow:0 -2px 8px rgba(0,0,0,.04)}" +
    ".vt-bar a{flex:1;height:50px;display:flex;flex-direction:column;align-items:center;gap:4px;font:500 12px/16px 'Prompt','Noto Sans Thai',system-ui,sans-serif;color:#8a949a;text-decoration:none;position:relative;white-space:nowrap}" +
    ".vt-bar svg{flex:none;width:24px;height:24px;stroke-width:1.8}" +
    ".vt-bar a.on{color:#0b5f67;font-weight:700}.vt-bar a.on svg{stroke-width:2.4}" +
    ".vt-bar .nb{position:absolute;top:-4px;left:50%;margin-left:4px;min-width:18px;height:18px;padding:0 6px;border-radius:10px;background:#e5484d;color:#fff;font:700 10px/18px 'Noto Sans Thai',system-ui,sans-serif;text-align:center;box-sizing:border-box}" +
    ".vt-bar .nb[hidden]{display:none}" +
    ".vt-bar .av{flex:none;width:24px;height:24px;border-radius:50%;background:#0e7c86;color:#fff;font:700 12px/24px 'Prompt','Noto Sans Thai',system-ui,sans-serif;text-align:center;overflow:hidden;display:block;box-sizing:border-box}" +
    ".vt-bar .av img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".vt-bar a.on .av{box-shadow:0 0 0 2px #fff,0 0 0 4px #0b5f67}" +
    "body.vt-on .toast,body.vt-on .tst{bottom:calc(88px + env(safe-area-inset-bottom,0px)) !important}" +
    "body.vt-on .vfoot{position:sticky;bottom:calc(72px + max(8px,env(safe-area-inset-bottom)));background:#fff;padding-top:10px;z-index:5}" +
    "body.vt-on{padding-bottom:calc(72px + max(8px,env(safe-area-inset-bottom))) !important}";
  function show(user) {
    if (document.querySelector(".vt-bar")) return;
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    var ini = String(user.name || "?").replace(/^[เแโใไ]/, "").slice(0, 1);
    function a(k, href, label, inner) { return '<a href="' + href + '" data-k="' + k + '"' + (active === k ? ' class="on" aria-current="page"' : "") + ">" + inner + label + "</a>"; }
    var nav = document.createElement("nav"); nav.className = "vt-bar"; nav.setAttribute("aria-label", "เมนูหลัก");
    nav.innerHTML =
      a("home", "/mytrips", "หน้าหลัก", icon("home")) +
      a("trips", "/mytrips#trips", "ทริปของฉัน", icon("trips")) +
      a("seats", "/mytrips#seats", "ที่นั่งของฉัน", icon("seats")) +
      a("notif", "/mytrips#notify", "แจ้งเตือน", icon("notif") + '<span class="nb" id="vtBadge" hidden></span>') +
      a("acct", "/mytrips#account", "โปรไฟล์", '<span class="av" id="vtAv"></span>');
    document.body.appendChild(nav); document.body.classList.add("vt-on"); document.documentElement.style.paddingBottom = "0"; /* the body padding already clears the bar + safe area; a page-level safe-area padding would add it twice */
    var av = document.getElementById("vtAv");
    if (user.pic) { var im = document.createElement("img"); im.alt = ""; im.src = user.pic; im.referrerPolicy = "no-referrer"; im.onerror = function () { av.textContent = ini; }; av.appendChild(im); } else av.textContent = ini;
    function badge() { var n = window.VSBBell && VSBBell.ready ? VSBBell.unread : 0, b = document.getElementById("vtBadge"); b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n); }
    if (window.VSBBell) { badge(); VSBBell.onChange(badge); }
  }
  function readCache() { try { var c = JSON.parse(localStorage.getItem("vsb_tb") || "null"); return c && localStorage.getItem("vsb_in") === "1" && !localStorage.getItem("vsb_gone") ? c : null; } catch (e) { return null; } }
  function paintAv(user) {
    var av = document.getElementById("vtAv"); if (!av) return;
    var ini = String(user.name || "?").replace(/^[เแโใไ]/, "").slice(0, 1);
    var cur = av.querySelector("img"); if (user.pic && cur && cur.getAttribute("src") === user.pic) return;
    av.textContent = ""; if (!user.pic) av.textContent = ini; if (user.pic) { var im = document.createElement("img"); im.alt = ""; im.src = user.pic; im.referrerPolicy = "no-referrer"; im.onerror = function () { av.textContent = ini; }; av.appendChild(im); }
  }
  var cached = readCache();
  if (cached) show(cached); // known signed-in device: draw the menu in the first frame, then confirm with the server
  fetch("/api/auth?me=1", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.user) {
      try { localStorage.setItem("vsb_tb", JSON.stringify({ name: d.user.name || "", pic: d.user.pic || "" })); } catch (e) {}
      if (document.querySelector(".vt-bar")) paintAv(d.user); else show(d.user);
    } else {
      var b = document.querySelector(".vt-bar"); if (b) { b.remove(); document.body.classList.remove("vt-on"); }
    }
  }).catch(function () {});
})();
