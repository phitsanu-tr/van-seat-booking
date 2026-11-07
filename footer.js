// One footer for every page: a van driving along a dotted road from the left edge of the screen to the right,
// a short travel line that changes every 4 s, and "© 2026 จองที่นั่งรถตู้ · ความเป็นส่วนตัว · เงื่อนไข · ติดต่อ".
// Use: <footer class="vfoot"></footer><script src="/footer.js"></script>  (a link to the page you're on becomes "กลับหน้าแรก")
(function () {
  var CONTACT = "phitsanu.tr@outlook.com";
  var LINES = ["ขอที่นั่งริมหน้าต่างก่อนนะ", "ถึงแล้วอย่าลืมบอกผู้ร่วมทริป", "เดินทางปลอดภัยนะ", "รถตู้ออกตรงเวลา ใจเย็นได้แต่ห้ามสาย", "อย่าลืมเตรียมขนมขึ้นรถ",
    "ชาร์จมือถือให้เต็มก่อนออกเดินทาง", "เมารถ? จองแถวหน้าไว้เลย", "แวะห้องน้ำก่อนออกรถนะ", "เพลงเพราะ ๆ ขึ้นรถไปด้วยกัน", "ยิ้มไว้ ทริปนี้สนุกแน่"];
  var SPEED = 44; // px per second: a phone-wide road (360px + the van off both edges) takes about 9–10 s
  var EVERY = 4000; // ms between lines

  if (!document.getElementById("vfootCss")) {
    var st = document.createElement("style"); st.id = "vfootCss";
    st.textContent =
      "html { overflow-x: clip; }" +
      ".vfoot { margin-top: auto; padding-top: 24px; text-align: center; font-size: 12px; line-height: 16px; color: #5f6b73; white-space: nowrap; }" +
      ".vfoot .vr { position: relative; width: 100vw; margin-left: calc(50% - 50vw); height: 28px; overflow: hidden; }" + // edge to edge, whatever the page padding
      ".vfoot .vr i { position: absolute; left: 0; right: 0; bottom: 4px; height: 2px; background: radial-gradient(circle, #0e7c86 1px, transparent 1.5px) 0 0 / 8px 2px repeat-x; }" +
      ".vfoot .vn { position: absolute; left: 0; bottom: 6px; width: 32px; height: auto; color: #1b1f22; transform: translateX(-40px); animation: vfvan var(--vfd, 10s) linear infinite; }" +
      "@keyframes vfvan { from { transform: translateX(-40px); } to { transform: translateX(var(--vfw, 400px)); } }" +
      "@media (prefers-reduced-motion: reduce) { .vfoot .vn { animation: none; transform: translateX(calc(50vw - 16px)); } }" +
      ".vfoot .vm { margin-top: 8px; transition: opacity .35s ease; }" +
      ".vfoot .vm.off { opacity: 0; }" +
      ".vfoot .vc { margin-top: 4px; white-space: normal; }" +
      ".vfoot a { color: inherit; text-decoration: none; }" +
      ".vfoot a:hover { text-decoration: underline; }";
    document.head.appendChild(st);
  }

  var VAN = '<svg class="vn" viewBox="4 12 88 42" fill="none" aria-hidden="true"><path d="M6 41V21a6 6 0 0 1 6-6h44c3 0 5 1 7 3.2L75 30l8 2.2a6 6 0 0 1 5 5.8V41a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="#fff" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><g fill="#c4e1e3" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="12" y="20" width="16" height="10" rx="2.5"/><rect x="32" y="20" width="16" height="10" rx="2.5"/><path d="M53 20h6.5c1.2 0 2 .4 2.8 1.3L67 28v2H53z"/></g><path d="M85 36h3" stroke="#0e7c86" stroke-width="3" stroke-linecap="round"/><circle cx="26" cy="43" r="9.5" fill="#fff"/><circle cx="26" cy="43" r="6.5" fill="currentColor"/><circle cx="26" cy="43" r="2.4" fill="#fff"/><circle cx="70" cy="43" r="9.5" fill="#fff"/><circle cx="70" cy="43" r="6.5" fill="currentColor"/><circle cx="70" cy="43" r="2.4" fill="#fff"/></svg>';

  function links() {
    var here = location.pathname.replace(/\/+$/, "") || "/", home = '<a href="/">กลับหน้าแรก</a>';
    var parts = [here === "/privacy" ? home : '<a href="/privacy">ความเป็นส่วนตัว</a>', here === "/terms" ? home : '<a href="/terms">เงื่อนไข</a>', '<a href="mailto:' + CONTACT + '">ติดต่อ</a>'];
    return "© 2026 จองที่นั่งรถตู้ · " + parts.join(" · ");
  }

  function mount(f) {
    if (f.getAttribute("data-on")) return; f.setAttribute("data-on", "1");
    f.innerHTML = '<div class="vr" aria-hidden="true"><i></i>' + VAN + '</div><div class="vm" aria-hidden="true"></div><div class="vc">' + links() + "</div>";
    var road = f.querySelector(".vr"), msg = f.querySelector(".vm"), q = [], last = -1;
    function size() { var w = road.clientWidth || window.innerWidth; f.style.setProperty("--vfw", w + 8 + "px"); f.style.setProperty("--vfd", ((w + 48) / SPEED).toFixed(2) + "s"); }
    size(); window.addEventListener("resize", size);
    function next() { // shuffled: every line once before any repeats, never the same line twice in a row
      if (!q.length) {
        for (var i = 0; i < LINES.length; i++) q.push(i);
        for (i = q.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = q[i]; q[i] = q[j]; q[j] = t; }
        if (q[q.length - 1] === last && q.length > 1) { t = q[0]; q[0] = q[q.length - 1]; q[q.length - 1] = t; }
      }
      last = q.pop(); return LINES[last];
    }
    msg.textContent = next();
    setInterval(function () { // its own clock, not tied to the van
      if (document.hidden) return;
      msg.classList.add("off");
      setTimeout(function () { msg.textContent = next(); msg.classList.remove("off"); }, 350);
    }, EVERY);
  }

  [].forEach.call(document.querySelectorAll("footer.vfoot"), mount);
})();
