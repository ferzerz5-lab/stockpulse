(function(){
  "use strict";

  // One script drives every page. Each page says what it is with data attributes on <body>:
  //   data-page="tape" | "aapl" | "nvda" | "wallets"   (other pages need no script)
  //   data-ticker="AAPL" | "NVDA"                       (ticker pages only)
  // Nothing here is ever simulated. If the feed is down, pages say so and stay empty.
  var body = document.body;
  var FILTER = body.getAttribute("data-ticker") || null;
  var EXPLORER = "https://robinhoodchain.blockscout.com";
  var ZERO = "0x0000000000000000000000000000000000000000";
  var WATCHLIST = ["AAPL", "NVDA"];
  var MAX_KEPT = 600, MAX_SHOWN = 60;

  var all = [];            // every transfer seen this visit, newest first
  var seen = new Set();
  var windowList = [];     // transfers from the most recent poll (the last ~5 minutes)
  var status = "connecting";   // connecting | live | offline
  var loaded = false;
  var firstLoad = true;
  var kindFilter = "all";
  var walletTicker = "AAPL";
  var counts = { AAPL: 0, NVDA: 0 };

  /* ---------------- preloader ----------------
     Shown once per browser session on the data pages. It ends when the first read of the chain
     finishes (data, error or offline), after a short minimum so the animation can be seen. */
  var preloadStart = Date.now();
  function hidePreload(){
    var p = $("preload");
    if(!p || p.classList.contains("out")) return;
    var wait = Math.max(0, 1100 - (Date.now() - preloadStart));
    setTimeout(function(){
      document.documentElement.classList.remove("preloading");   // lets the page entrance play
      p.classList.add("out");
      setTimeout(function(){ if(p.parentNode) p.parentNode.removeChild(p); }, 600);
    }, wait);
  }

  /* ---------------- helpers ---------------- */
  function $(id){ return document.getElementById(id); }
  function setText(id, text){ var e = $(id); if(e) e.textContent = text; }
  function hexOk(s){ return typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s); }
  function shortAddr(a){
    if(!hexOk(a)) return "unknown";
    return a.slice(0,6) + "\u2026" + a.slice(-4);
  }
  function fmtShares(n){
    n = Number(n) || 0;
    if(n === 0) return "0";
    if(n >= 1e6) return (n/1e6).toFixed(2) + "M";
    if(n >= 1e3) return (n/1e3).toFixed(1) + "K";
    if(n >= 1) return n.toFixed(2);
    return n.toFixed(4);
  }
  function timeAgo(ts){
    var t = new Date(ts).getTime();
    if(isNaN(t)) return "";
    var s = Math.max(0, Math.floor((Date.now() - t)/1000));
    if(s < 60) return s + "s ago";
    if(s < 3600) return Math.floor(s/60) + "m ago";
    return Math.floor(s/3600) + "h ago";
  }
  function keyOf(t){ return t.txHash + ":" + t.logIndex; }
  function kindOf(t){
    var f = String(t.from || "").toLowerCase(), to = String(t.to || "").toLowerCase();
    if(f === ZERO) return "mint";   // ERC-20 convention: from the zero address
    if(to === ZERO) return "burn";  // ERC-20 convention: to the zero address
    return "transfer";
  }
  function symOk(t){ return !FILTER || t.symbol === FILTER; }
  function sortNewestFirst(a, b){
    if(b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return (parseInt(b.logIndex, 16) || 0) - (parseInt(a.logIndex, 16) || 0);
  }
  function pulse(el, cls){
    if(!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;       // restart the animation
    el.classList.add(cls);
  }

  /* ---------------- status lamp ---------------- */
  function setLamp(live, message){
    var lamp = $("lamp"), text = $("lampText"), note = $("demoNote");
    if(!lamp || !text) return;
    if(live){
      lamp.className = "lamp live";
      text.textContent = "printing live";
      if(note) note.classList.remove("show");
    } else {
      lamp.className = "lamp demo";
      text.textContent = "feed offline";
      if(note){ note.textContent = message || ""; note.classList.add("show"); }
    }
  }

  /* ---------------- odometer and gauge (tape and ticker pages) ---------------- */
  function setDial(sym, n){
    var dial = $("dial" + sym);
    if(!dial) return;
    var digits = String(Math.min(9999, n)).padStart(4, "0").split("");
    var spans = dial.querySelectorAll(".counter-digit");
    digits.forEach(function(d, i){
      var s = spans[i];
      if(s && s.textContent !== d){ s.textContent = d; pulse(s, "roll"); }
    });
  }
  var gaugeLevel = 0;
  function setGauge(level){
    var needle = $("gaugeNeedle");
    if(!needle) return;
    gaugeLevel = Math.max(0, Math.min(1, level));
    needle.style.transform = "rotate(" + (-90 + gaugeLevel * 180) + "deg)";
  }
  setInterval(function(){ setGauge(gaugeLevel * 0.9); }, 1200);

  /* ---------------- debug panel (?debug=1) ---------------- */
  var debugMode = window.location.search.indexOf("debug=1") !== -1;
  var debugPanel = $("debugPanel");
  if(debugMode && debugPanel) debugPanel.style.display = "block";
  function renderDebug(json){
    if(!debugMode) return;
    var out = $("debugOutput");
    if(!out) return;
    var raw = JSON.stringify(json, null, 2);
    out.textContent = raw.length > 4000 ? raw.slice(0,4000) + "\n...(truncated)" : raw;
  }

  /* ---------------- tape ---------------- */
  function emptyText(){
    if(status === "connecting") return "Connecting to the chain.";
    if(status === "offline") return "The feed is offline. Nothing on this page is simulated, so the tape stays empty until it is back.";
    if(kindFilter === "mint") return "No mints in this window.";
    if(kindFilter === "burn") return "No burns in this window.";
    if(kindFilter === "transfer") return "No wallet-to-wallet transfers in this window.";
    return "No transfers in the last five minutes. The tape prints the moment one lands.";
  }
  function routeHtml(t){
    var k = kindOf(t);
    if(k === "mint") return '<span class="kind">mint</span> to ' + shortAddr(t.to);
    if(k === "burn") return shortAddr(t.from) + ' <span class="kind">burn</span>';
    return shortAddr(t.from) + '<span class="arrow">\u2192</span>' + shortAddr(t.to);
  }
  function renderTape(freshKeys){
    var tape = $("tape");
    if(!tape) return;
    var list = all.filter(function(t){
      return symOk(t) && (kindFilter === "all" || kindOf(t) === kindFilter);
    }).slice(0, MAX_SHOWN);
    if(!list.length){ tape.innerHTML = '<div class="empty-entry">' + emptyText() + '</div>'; return; }
    var html = "", i = 0;
    list.forEach(function(t){
      var fresh = freshKeys && freshKeys[keyOf(t)];
      var cls = WATCHLIST.indexOf(t.symbol) > -1 ? t.symbol : "other";
      var href = hexOk(t.txHash) ? EXPLORER + "/tx/" + t.txHash : "#";
      html += '<a class="entry' + (fresh ? ' fresh' : '') + '" href="' + href + '" target="_blank" rel="noopener" title="Open this transaction on the block explorer"' +
        (fresh ? ' style="animation-delay:' + (Math.min(i, 12) * 45) + 'ms"' : '') + '>' +
        '<span class="sym ' + cls + '">' + t.symbol + '</span>' +
        '<span class="route">' + routeHtml(t) + '</span>' +
        '<span class="meta"><span class="shares">' + fmtShares(t.amount) + '</span><span class="ago" data-ts="' + t.time + '">' + timeAgo(t.time) + '</span></span></a>';
      if(fresh) i++;
    });
    tape.innerHTML = html;
  }
  // Keep the "Xs ago" labels honest as time passes.
  setInterval(function(){
    var labels = document.querySelectorAll(".ago[data-ts]");
    for(var i = 0; i < labels.length; i++) labels[i].textContent = timeAgo(labels[i].getAttribute("data-ts"));
  }, 5000);

  /* ---------------- stats (last poll window only) ---------------- */
  function renderStats(){
    if(!$("stats")) return;
    if(!loaded){
      ["statCount","statWallets","statSharesAAPL","statSharesNVDA","statShares","statLargest","statKinds"].forEach(function(id){ setText(id, "-"); });
      return;
    }
    var list = windowList.filter(symOk);
    var wallets = {}, shares = { AAPL: 0, NVDA: 0 }, largest = null, mints = 0, burns = 0;
    list.forEach(function(t){
      [t.from, t.to].forEach(function(a){ a = String(a || "").toLowerCase(); if(a && a !== ZERO) wallets[a] = true; });
      if(shares[t.symbol] !== undefined) shares[t.symbol] += t.amount;
      if(!largest || t.amount > largest.amount) largest = t;
      var k = kindOf(t); if(k === "mint") mints++; else if(k === "burn") burns++;
    });
    setText("statCount", String(list.length));
    setText("statWallets", String(Object.keys(wallets).length));
    setText("statSharesAAPL", fmtShares(shares.AAPL));
    setText("statSharesNVDA", fmtShares(shares.NVDA));
    setText("statShares", fmtShares(FILTER ? shares[FILTER] : shares.AAPL + shares.NVDA));
    setText("statLargest", largest ? fmtShares(largest.amount) + (FILTER ? "" : " " + largest.symbol) : "none");
    setText("statKinds", mints + (mints === 1 ? " mint, " : " mints, ") + burns + (burns === 1 ? " burn" : " burns"));
  }

  /* ---------------- wallets page ---------------- */
  function renderWallets(){
    var tbody = $("walletsBody");
    if(!tbody) return;
    var map = {};
    all.forEach(function(t){
      if(t.symbol !== walletTicker) return;
      var from = String(t.from || "").toLowerCase(), to = String(t.to || "").toLowerCase();
      [[from, "sent"], [to, "recv"]].forEach(function(p){
        var a = p[0];
        if(!a || a === ZERO) return;
        var w = map[a] || (map[a] = { addr: a, n: 0, sent: 0, recv: 0 });
        if(!(p[1] === "recv" && from === to)) w.n++;   // a self-transfer counts once
        w[p[1]] += t.amount;
      });
    });
    var rows = Object.keys(map).map(function(k){ return map[k]; })
      .sort(function(a, b){ return (b.sent + b.recv) - (a.sent + a.recv); }).slice(0, 15);
    setText("walletsMeta", status === "live" || loaded
      ? Object.keys(map).length + " " + walletTicker + " wallets seen on this visit"
      : "");
    if(!rows.length){
      var msg = status === "offline" && !loaded ? "The feed is offline. Nothing here is simulated." :
                status === "connecting" ? "Connecting to the chain." :
                "No " + walletTicker + " wallets seen yet. This list fills as transfers arrive.";
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">' + msg + '</td></tr>';
      return;
    }
    var html = "";
    rows.forEach(function(w, i){
      html += '<tr><td class="rank">' + (i + 1) + '</td>' +
        '<td><a href="' + EXPLORER + '/address/' + w.addr + '" target="_blank" rel="noopener">' + shortAddr(w.addr) + '</a></td>' +
        '<td class="num">' + w.n + '</td><td class="num">' + fmtShares(w.sent) + '</td><td class="num">' + fmtShares(w.recv) + '</td></tr>';
    });
    tbody.innerHTML = html;
  }

  /* ---------------- polling ---------------- */
  function goOffline(message){
    status = "offline";
    setLamp(false, message);
    renderTape(null); renderStats(); renderWallets();
    hidePreload();
  }
  function handle(json){
    renderDebug(json);
    if(json.demo){ goOffline("The live feed is not connected yet. Nothing on this page is simulated, so it stays empty until it is."); return; }
    if(json.error){ goOffline("The feed hit an error and retries every 20 seconds. Nothing on this page is simulated."); return; }
    status = "live"; loaded = true;
    setLamp(true);
    var transfers = (json.data && json.data.transfers) || [];
    windowList = transfers;

    var fresh = {}, added = 0;
    transfers.forEach(function(t){            // logs arrive oldest first
      var k = keyOf(t);
      if(seen.has(k)) return;
      seen.add(k); all.push(t); fresh[k] = true; added++;
      if(symOk(t) && counts[t.symbol] !== undefined){
        counts[t.symbol]++; setDial(t.symbol, counts[t.symbol]);
        var level = Math.min(1, Math.max(0.15, t.amount / 60));
        setGauge(t.symbol === "NVDA" ? 0.5 - level * 0.5 : 0.5 + level * 0.5);
      }
    });
    all.sort(sortNewestFirst);
    if(all.length > MAX_KEPT) all.length = MAX_KEPT;

    renderTape(fresh);
    renderStats();
    renderWallets();
    if(added > 0 && !firstLoad) pulse(document.querySelector(".slot"), "pulse");
    firstLoad = false;
    hidePreload();
  }
  function poll(){
    if(document.hidden) return;   // a hidden tab asks for nothing
    fetch("/api/transfers", { headers: { "Accept": "application/json" } })
      .then(function(r){ return r.json().catch(function(){ return { error: "Unreadable response from /api/transfers" }; }); })
      .then(handle)
      .catch(function(err){
        renderDebug({ fetchError: String(err && err.message ? err.message : err) });
        goOffline("Can't reach the feed right now. It retries every 20 seconds. Nothing on this page is simulated.");
      });
  }

  /* ---------------- filter buttons ---------------- */
  function wireButtons(attr, onPick){
    var btns = document.querySelectorAll("[" + attr + "]");
    Array.prototype.forEach.call(btns, function(b){
      b.addEventListener("click", function(){
        Array.prototype.forEach.call(btns, function(x){ x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
        b.classList.add("active"); b.setAttribute("aria-pressed", "true");
        onPick(b.getAttribute(attr));
      });
    });
  }
  wireButtons("data-kind", function(v){ kindFilter = v; renderTape(null); });
  wireButtons("data-wticker", function(v){ walletTicker = v; renderWallets(); });

  /* ---------------- start ---------------- */
  renderTape(null); renderStats(); renderWallets();
  poll();
  setInterval(poll, 20000);
  document.addEventListener("visibilitychange", function(){ if(!document.hidden) poll(); });

})();
