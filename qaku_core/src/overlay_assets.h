#pragma once
// The OBS overlay page, embedded as a single translation-unit constant.
//
// Embedded rather than shipped as a file because qaku_core is a `core` module:
// its CMake enumerates SOURCES explicitly and it has no asset-install path, so a
// bundled .html would need both a packaging change and runtime path resolution.
// A raw string literal needs neither and cannot go missing at load time.
//
// The duck is brand/qaku-duck-white.svg inlined verbatim (this is that file's
// first consumer in the repo). Palette is qaku's own, from module/Main.qml and
// mobile/App.tsx: bg #141415, surface #1a1a1d, border #303035, gold #ffc533,
// teal #50b986, muted #9f9fab, answer body #d8d8e0.
#include <string>

namespace qaku {
namespace overlay {

inline const std::string kIndexHtml = R"QAKUOVL(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QAKU overlay</title>
<style>
  /* Transparent all the way down: OBS composites the scene video behind this page. */
  html, body { background: transparent; margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body {
    font-family: "Public Sans", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
    -webkit-font-smoothing: antialiased;
  }

  /* The panel. A flat rgba() fill, NOT backdrop-filter: in OBS's CEF the page has
     nothing behind it to sample, so a backdrop filter is a no-op that still costs
     frames. This is what actually reads as semi-transparent over the video. */
  #panel {
    position: fixed; top: 0; left: 0; bottom: 0;
    width: var(--w, 420px);
    background: rgba(20, 20, 21, var(--opacity, 0.72));
    border-right: 1px solid rgba(48, 48, 53, 0.9);
    display: flex; flex-direction: column;
  }

  header {
    display: flex; align-items: center; gap: 12px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid rgba(48, 48, 53, 0.9);
    flex: 0 0 auto;
  }
  .duck { width: 34px; height: 34px; flex: 0 0 auto; }
  .duck path { fill: #ffffff; }
  .htext { min-width: 0; }
  #topic {
    font-size: 19px; font-weight: 700; line-height: 1.25;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  #count { font-size: 12px; color: #9f9fab; margin-top: 3px; letter-spacing: .04em; text-transform: uppercase; }

  /* Scroll viewport. Overflow hidden + a translated inner track, so the loop is a
     transform (GPU) rather than a scroll the compositor has to chase. */
  #view { position: relative; flex: 1 1 auto; overflow: hidden;
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(to bottom, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%); }
  #track { position: absolute; top: 0; left: 0; right: 0; padding: 14px 18px 24px; will-change: transform; }

  .q { background: #1a1a1d; border: 1px solid #303035; border-radius: 6px;
       padding: 12px; margin-bottom: 8px; display: flex; gap: 10px; }
  .q.answered { border-left: 3px solid #50b986; }

  /* align-self so the pill keeps its own height; a flex child defaults to
     stretch, which made it a full-height column down the side of long cards. */
  .pill { flex: 0 0 auto; align-self: flex-start; width: 58px; min-height: 52px; border-radius: 4px; background: #141415;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
  .arrow { color: #ffc533; font-size: 14px; line-height: 1; }
  .votes { font-size: 15px; font-weight: 700; line-height: 1; }

  .body { min-width: 0; flex: 1 1 auto; }
  .qtext { font-size: 17px; line-height: 1.35; overflow-wrap: anywhere; }
  .meta { font-size: 12px; color: #9f9fab; margin-top: 6px; }
  .dot { opacity: .5; margin: 0 5px; }

  .a { margin-top: 9px; padding-left: 11px; border-left: 2px solid #303035;
       font-size: 15px; line-height: 1.35; color: #d8d8e0; overflow-wrap: anywhere; }
  .a.acc { border-left-color: #50b986; color: #ffffff; }
  .a .tick { color: #50b986; font-weight: 700; margin-right: 5px; }
  .a .who { display: block; font-size: 11px; color: #9f9fab; margin-top: 3px; }

  #empty { padding: 28px 18px; color: #9f9fab; font-size: 15px; line-height: 1.5; }
  #offline { padding: 10px 18px; color: #e6194b; font-size: 12px; display: none; }
</style>
</head>
<body>
<div id="panel">
  <header>
    <svg class="duck" viewBox="0 0 74 74" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M25.7883 10.177C25.9553 10.0523 26.2057 9.96927 26.4144 10.0108L34.1782 10.4262C34.387 10.4262 34.5957 10.5093 34.7626 10.6754L43.6534 18.4015C43.9039 18.6092 44.0291 18.8999 43.9874 19.2322L43.3195 27.3321C43.3195 27.5398 43.236 27.706 43.1108 27.8306L38.6445 33.5628L42.1925 33.1474L51.9599 31.9428L59.7237 28.8275C60.4333 28.5367 61.1846 29.1598 61.0594 29.9075L60.3081 34.6013L63.4804 45.235C63.5221 45.4011 63.5221 45.5673 63.4804 45.6919L61.1846 57.2395C61.1429 57.5302 60.9342 57.7795 60.6837 57.9041L54.7565 60.8948C54.673 60.9363 54.5478 60.9779 54.4226 60.9779L33.2182 63.5117C33.093 63.5117 32.9678 63.5117 32.8425 63.5117L19.9029 60.2302C19.7359 60.1887 19.5689 60.1056 19.4437 59.981L10.3024 51.0918C10.052 50.8426 9.96851 50.5518 10.0102 50.2195L11.7634 41.0812C11.8051 40.7904 12.0138 40.4997 12.306 40.375L22.1569 35.8474L19.0263 32.5659H12.6817C11.8469 32.5659 11.3877 31.6105 11.9303 30.9875L15.3948 26.7091L10.4694 19.9799C9.88503 19.1907 10.6781 18.1522 11.5547 18.4845L15.7288 19.8553L16.6888 20.1461L17.941 15.9507C18.0245 15.743 18.1497 15.5769 18.3167 15.4523L25.7883 10.177ZM15.3113 21.2261L16.6471 21.683C16.6888 21.683 16.7723 21.683 16.814 21.683L22.4908 25.5045L14.8939 29.5752L16.7305 27.3321C17.0227 26.9998 17.0227 26.5014 16.7305 26.1275L12.5147 20.3953L15.3113 21.2261ZM14.9357 31.1952H18.9846L21.5307 27.6644L14.9357 31.1952ZM23.743 35.4736L30.5885 39.3781L23.743 26.9168L20.2368 31.7767M31.5068 41.5381L23.3673 36.8859L14.2261 41.0812L27.5832 47.2288L31.5068 41.4966V41.5381ZM25.3292 47.7688L13.0573 42.1196L11.5964 49.6796L25.3292 47.7688ZM12.2225 51.0088L19.8611 58.5271L26.331 49.0565L12.2225 51.0088ZM21.1551 59.1917L28.0841 49.0565L38.0602 53.6672L32.7173 62.1409L21.1551 59.2333V59.1917ZM34.4287 62.0163L51.7929 59.9394L39.3541 54.2072L34.4287 62.0163ZM40.1055 53.0441L54.3391 59.6071L58.9724 57.281L43.1525 48.2673L40.1055 53.0857V53.0441ZM45.2396 47.7688L59.9741 56.201L61.936 46.315L45.2396 47.7688ZM61.8942 44.9027L58.9306 34.9336C58.9306 34.809 58.8889 34.6428 58.9306 34.5182L59.5985 30.489L52.6695 33.2721L44.3213 46.4396L61.8942 44.9027ZM50.7494 33.5628L42.6934 46.315L33.5104 41.0812L37.601 35.1413C37.6427 35.1413 37.7262 35.1413 37.8097 35.1413L42.4012 34.6013L50.7911 33.5628H50.7494ZM32.5504 40.0012L25.1205 26.4598L41.0655 27.9552M42.0255 25.7952L42.5682 19.3568L34.3452 12.2123L31.966 15.5354L42.0255 25.7952ZM30.9642 14.4969L32.926 11.7969L28.0423 11.5062L30.9642 14.4969ZM26.164 11.6308L30.1294 15.66L23.7013 24.6322L17.9828 20.7691L19.2767 16.4907L26.2057 11.6308H26.164ZM25.1622 25.006L31.1312 16.6984L40.7316 26.5014L25.1622 25.006ZM32.7173 42.2443L41.9421 47.5196L38.8115 52.4626L28.8772 47.8934L32.7173 42.2858V42.2443Z" fill="white"/></svg>
    <div class="htext">
      <div id="topic">QAKU</div>
      <div id="count"></div>
    </div>
  </header>
  <div id="offline">overlay disconnected - is qaku_core running?</div>
  <div id="view"><div id="track"><div id="empty">Waiting for questions...</div></div></div>
</div>

<script>
(function () {
  "use strict";

  // Tuning without a rebuild: ?w=420&opacity=0.72&speed=15
  var qs = new URLSearchParams(location.search);
  var num = function (k, dflt, lo, hi) {
    var v = parseFloat(qs.get(k));
    return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };
  var WIDTH   = num("w", 420, 200, 1200);
  var OPACITY = num("opacity", 0.72, 0, 1);
  var SPEED   = num("speed", 15, 3, 120);   // seconds to travel one screen height
  document.documentElement.style.setProperty("--w", WIDTH + "px");
  document.documentElement.style.setProperty("--opacity", String(OPACITY));

  var view  = document.getElementById("view");
  var track = document.getElementById("track");
  var topic = document.getElementById("topic");
  var count = document.getElementById("count");
  var offline = document.getElementById("offline");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function ago(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m";
    if (d < 86400000) return Math.floor(d / 3600000) + "h";
    return Math.floor(d / 86400000) + "d";
  }

  function render(data) {
    topic.textContent = data.title || "QAKU";
    var qs_ = data.questions || [];
    count.textContent = qs_.length === 1 ? "1 question" : qs_.length + " questions";

    if (!qs_.length) {
      track.innerHTML = '<div id="empty">Waiting for questions...</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < qs_.length; i++) {
      var q = qs_[i];
      var answers = q.answers || [];
      html += '<div class="q' + (q.answered ? " answered" : "") + '">'
            +   '<div class="pill"><div class="arrow">&#9650;</div><div class="votes">' + (q.upvotes | 0) + '</div></div>'
            +   '<div class="body">'
            +     '<div class="qtext">' + esc(q.content) + '</div>'
            +     '<div class="meta">' + esc(q.author) + '<span class="dot">&middot;</span>' + esc(ago(q.ts)) + '</div>';
      for (var j = 0; j < answers.length; j++) {
        var a = answers[j];
        html += '<div class="a' + (a.accepted ? " acc" : "") + '">'
              +   (a.accepted ? '<span class="tick">&#10003;</span>' : "")
              +   esc(a.content)
              +   '<span class="who">' + esc(a.author) + '</span>'
              + '</div>';
      }
      html += '</div></div>';
    }
    track.innerHTML = html;
  }

  // ---- auto-scroll: drift down one screen every SPEED seconds, hold, ease back ----
  var offset = 0, phase = "scroll", phaseStart = 0, last = 0, backFrom = 0;
  var HOLD_MS = 2500, RETURN_MS = 1100, TOP_HOLD_MS = 1000;

  function maxOffset() { return Math.max(0, track.scrollHeight - view.clientHeight); }

  function frame(now) {
    if (!last) last = now;
    var dt = Math.min(100, now - last);   // a stalled tab must not teleport the list
    last = now;

    var max = maxOffset();
    if (max <= 0) {
      offset = 0; phase = "scroll"; phaseStart = 0;
    } else if (phase === "scroll") {
      offset += (view.clientHeight / (SPEED * 1000)) * dt;
      if (offset >= max) { offset = max; phase = "hold"; phaseStart = now; }
    } else if (phase === "hold") {
      if (now - phaseStart >= HOLD_MS) { phase = "back"; phaseStart = now; backFrom = offset; }
    } else if (phase === "back") {
      var t = Math.min(1, (now - phaseStart) / RETURN_MS);
      var e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;   // ease-in-out
      offset = backFrom * (1 - e);
      if (t >= 1) { offset = 0; phase = "tophold"; phaseStart = now; }
    } else if (phase === "tophold") {
      if (now - phaseStart >= TOP_HOLD_MS) { phase = "scroll"; }
    }

    if (offset > max) offset = max;   // content shrank under us (a question was hidden)
    track.style.transform = "translateY(" + (-offset).toFixed(2) + "px)";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- poll ----
  // Matches the desktop view's own stance (Main.qml: module events are not
  // reliably delivered, so it polls snapshot on a timer). Re-render only when
  // `rev` moves, so the scroll position survives every quiet tick.
  var lastRev = null;
  function tick() {
    fetch("overlay.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        offline.style.display = "none";
        if (data.rev !== lastRev) { lastRev = data.rev; render(data); }
      })
      .catch(function () { offline.style.display = "block"; });
  }
  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>
)QAKUOVL";

}  // namespace overlay
}  // namespace qaku
