(() => {
  const INTERVALS = {
    market: 60_000,
    movers: 60_000,
    chart:  60_000,
    news:   300_000,
    scan:   900_000,
  };
  const SCAN_INITIAL_DELAY = 3_000;
  const CHART_CACHE_PREFIX = "sp500cache:v2:chart:";

  const RANGE_FETCH = { "5d": "1mo", "1mo": "6mo", "3mo": "1y", "6mo": "2y", "1y": "2y" };
  const RANGE_DISPLAY_COUNT = { "5d": null, "1mo": 22, "3mo": 66, "6mo": 132, "1y": 252 };

  const state = {
    ticker: CFG.DEFAULT_TICKER,
    range: "1mo",
    moverTab: "gainers",
    scanRunning: false,
    timers: {},
    indicators: { sma20: true, sma50: true, bollinger: true },
    lastRender: null,
    lastMovers: [],
    lastQuotes: [],
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = (n) => (n == null || isNaN(n)) ? "—" : `${(n * 100).toFixed(2)}%`;
  const fmtSignedPct = (n) => {
    if (n == null || isNaN(n)) return "—";
    const v = (n * 100).toFixed(2);
    return n >= 0 ? `+${v}%` : `${v}%`;
  };
  const nowTime = () => new Date().toLocaleTimeString("de-DE");

  function setStamp(id, refreshing) {
    const el = $(id);
    if (!el) return;
    if (refreshing) { el.classList.add("refreshing"); el.textContent = "aktualisiert…"; }
    else { el.classList.remove("refreshing"); el.textContent = nowTime(); }
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove("flash-update");
    void el.offsetWidth;
    el.classList.add("flash-update");
  }

  function cacheChartKey(sym, range) { return `${CHART_CACHE_PREFIX}${sym}:${range}`; }
  function loadCachedChart(sym = state.ticker, range = state.range) {
    try {
      const raw = localStorage.getItem(cacheChartKey(sym, range));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.ts > CFG.CHART_CACHE_TTL_MS) return null;
      obj.points = obj.points.map(p => ({ ...p, t: new Date(p.t) }));
      return obj;
    } catch { return null; }
  }
  function saveCachedChart(sym, range, meta, points, pre, fullCloses) {
    try {
      localStorage.setItem(cacheChartKey(sym, range), JSON.stringify({
        ts: Date.now(), meta, pre, fullCloses,
        points: points.map(p => ({ ...p, t: p.t.toISOString() })),
      }));
    } catch {}
  }

  function computeIndicatorsSliced(fullPoints, displayCount) {
    const closes = fullPoints.map(p => p.c);
    const sma20Full = IND.sma(closes, 20);
    const sma50Full = IND.sma(closes, 50);
    const bbFull = IND.bollinger(closes, 20, 2);
    const startIdx = displayCount ? Math.max(0, fullPoints.length - displayCount) : 0;
    const points = fullPoints.slice(startIdx);
    return {
      points,
      pre: {
        sma20: sma20Full.slice(startIdx),
        sma50: sma50Full.slice(startIdx),
        bbUpper: bbFull.upper.slice(startIdx),
        bbLower: bbFull.lower.slice(startIdx),
        bbMid: bbFull.mid.slice(startIdx),
      },
      fullCloses: closes,
    };
  }

  async function loadMarketSummary({ silent = false } = {}) {
    try {
      const qs = await API.getQuotes(["^GSPC", "^VIX", "^TNX"]);
      const map = Object.fromEntries(qs.map(q => [q.symbol, q]));
      const spx = map["^GSPC"], vix = map["^VIX"], tnx = map["^TNX"];
      if (spx) {
        const prevTxt = $("spx-value").textContent;
        const next = fmt(spx.regularMarketPrice);
        $("spx-value").textContent = next;
        const d = $("spx-delta");
        d.textContent = fmtSignedPct(spx.regularMarketChangePercent / 100);
        d.className = "delta " + (spx.regularMarketChangePercent >= 0 ? "up" : "down");
        if (silent && prevTxt !== "—" && prevTxt !== next) flash($("spx-value"));
      }
      if (vix) {
        $("vix-value").textContent = fmt(vix.regularMarketPrice);
        const d = $("vix-delta");
        d.textContent = fmtSignedPct(vix.regularMarketChangePercent / 100);
        d.className = "delta " + (vix.regularMarketChangePercent >= 0 ? "up" : "down");
      }
      if (tnx) {
        $("tnx-value").textContent = `${fmt(tnx.regularMarketPrice)}%`;
        const d = $("tnx-delta");
        d.textContent = fmtSignedPct(tnx.regularMarketChangePercent / 100);
        d.className = "delta " + (tnx.regularMarketChangePercent >= 0 ? "up" : "down");
      }
      $("last-update").textContent = nowTime();
    } catch (e) {
      console.warn("Market summary error", e);
    }
  }

  async function loadMovers({ silent = false, kind = state.moverTab } = {}) {
    const list = $("movers-list");
    setStamp("movers-stamp", true);
    if (!silent && !list.querySelector(".mover-row")) list.innerHTML = "Lade…";
    try {
      let quotes = await API.getQuotes(CFG.SCAN_TICKERS);
      // Bei (teilweisem) Proxy-Ausfall: letzten guten Stand wiederverwenden statt Fehler
      if (quotes.length < 5 && state.lastQuotes.length) {
        quotes = state.lastQuotes;
      } else if (quotes.length >= 5) {
        state.lastQuotes = quotes;
      }
      if (!quotes.length) throw new Error("Keine Quotes erhalten (Proxy evtl. überlastet)");
      let sorted = quotes.filter(q => q.regularMarketPrice != null);
      if (kind === "gainers") sorted.sort((a, b) => (b.regularMarketChangePercent || 0) - (a.regularMarketChangePercent || 0));
      else if (kind === "losers") sorted.sort((a, b) => (a.regularMarketChangePercent || 0) - (b.regularMarketChangePercent || 0));
      else sorted.sort((a, b) => (b.regularMarketVolume || 0) - (a.regularMarketVolume || 0));
      sorted = sorted.slice(0, 20);
      state.lastMovers = sorted;
      list.innerHTML = sorted.map(q => {
        const chg = q.regularMarketChangePercent || 0;
        const cls = chg >= 0 ? "up" : "down";
        const sign = chg >= 0 ? "+" : "";
        return `<div class="mover-row" data-sym="${q.symbol}">
          <span class="sym">${q.symbol}</span>
          <span class="price">$${fmt(q.regularMarketPrice)}</span>
          <span class="chg ${cls}">${sign}${chg.toFixed(2)}%</span>
        </div>`;
      }).join("");
      list.querySelectorAll(".mover-row").forEach(row => {
        row.addEventListener("click", () => selectTicker(row.dataset.sym));
      });
      setStamp("movers-stamp", false);
      prefetchMoverCharts(sorted.slice(0, 6));
    } catch (e) {
      console.warn("Movers error", e);
      // Letzten guten Stand behalten falls vorhanden
      if (!list.querySelector(".mover-row") && !silent) {
        list.innerHTML = `<div class="news-item">Daten gerade nicht abrufbar (${e.message}). Nächster Versuch in 60s.</div>`;
      }
      setStamp("movers-stamp", false);
    }
  }

  async function prefetchMoverCharts(movers) {
    for (const m of movers) {
      if (m.symbol === state.ticker) continue;
      const cached = loadCachedChart(m.symbol, "1mo");
      if (cached) continue;
      try {
        const { meta, points: fullPoints } = await API.getChart(m.symbol, RANGE_FETCH["1mo"], "1d");
        const { points, pre, fullCloses } = computeIndicatorsSliced(fullPoints, RANGE_DISPLAY_COUNT["1mo"]);
        saveCachedChart(m.symbol, "1mo", meta, points, pre, fullCloses);
      } catch (e) {
        console.debug("Prefetch fehlgeschlagen", m.symbol);
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  function renderChartFromCache(cached) {
    state.lastRender = { meta: cached.meta, points: cached.points, pre: cached.pre, fullCloses: cached.fullCloses };
    CHARTS.render("price-chart", cached.points, state.ticker, state.indicators, cached.pre);
    updateChartHeaderAndMetrics(cached.meta, cached.points, cached.pre, cached.fullCloses);
  }

  function updateChartHeaderAndMetrics(meta, points, pre, fullCloses) {
    $("chart-title").textContent = state.ticker;
    const price = meta.regularMarketPrice;
    // Tagesänderung (gestriger Schluss), nicht die Änderung über den Hol-Zeitraum
    const prev = meta.previousClose || meta.chartPreviousClose;
    const chg = price - prev;
    const chgPct = chg / prev;
    const cls = chg >= 0 ? "up" : "down";
    $("chart-sub").innerHTML = `$${fmt(price)} <span class="${cls}">${chg >= 0 ? "+" : ""}${fmt(chg)} (${fmtSignedPct(chgPct)})</span>`;

    const closes = points.map(p => p.c);
    // Indikatoren wie RSI/MACD brauchen die VOLLE Serie, nicht nur das Anzeige-Fenster
    const series = (fullCloses && fullCloses.length >= closes.length) ? fullCloses : closes;
    const high = Math.max(...points.map(p => p.h));
    const low = Math.min(...points.map(p => p.l));
    const vol = points[points.length - 1]?.v;
    const returns = [];
    for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const hv = Math.sqrt(variance * 252);

    const rsiVals = IND.rsi(series, 14);
    const rsi = rsiVals[rsiVals.length - 1];
    const rsiCls = rsi == null ? "neutral" : (rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral");
    const rsiLabel = rsi == null ? "—" : (rsi < 30 ? "Oversold" : rsi > 70 ? "Overbought" : "Neutral");

    const lastSma20 = pre?.sma20?.[pre.sma20.length - 1];
    const lastSma50 = pre?.sma50?.[pre.sma50.length - 1];
    let trend = "—";
    if (lastSma20 != null && lastSma50 != null) {
      if (price > lastSma20 && lastSma20 > lastSma50) trend = "↑ Bullish";
      else if (price < lastSma20 && lastSma20 < lastSma50) trend = "↓ Bearish";
      else trend = "↔ Mixed";
    }

    const macdRes = IND.macd(series);
    const macdHist = macdRes.hist[macdRes.hist.length - 1];
    const macdSignal = macdHist == null ? "—" : (macdHist > 0 ? `↑ Bullish (${macdHist.toFixed(2)})` : `↓ Bearish (${macdHist.toFixed(2)})`);

    $("ticker-metrics").innerHTML = `
      <div class="metric-cell"><span class="k">Periode Hoch</span><span class="v">$${fmt(high)}</span></div>
      <div class="metric-cell"><span class="k">Periode Tief</span><span class="v">$${fmt(low)}</span></div>
      <div class="metric-cell"><span class="k">52W Hoch</span><span class="v">$${fmt(meta.fiftyTwoWeekHigh)}</span></div>
      <div class="metric-cell"><span class="k">52W Tief</span><span class="v">$${fmt(meta.fiftyTwoWeekLow)}</span></div>
      <div class="metric-cell"><span class="k">Volumen</span><span class="v">${vol ? vol.toLocaleString("de-DE") : "—"}</span></div>
      <div class="metric-cell"><span class="k">HV (annualisiert)</span><span class="v">${fmtPct(hv)}</span></div>
      <div class="metric-cell"><span class="k">RSI (14)</span><span class="v">${rsi == null ? "—" : rsi.toFixed(1)} <span class="rsi-badge ${rsiCls}">${rsiLabel}</span></span></div>
      <div class="metric-cell"><span class="k">SMA Trend</span><span class="v">${trend}</span></div>
      <div class="metric-cell"><span class="k">MACD</span><span class="v">${macdSignal}</span></div>
    `;
  }

  async function loadChart({ silent = false, retry = 1 } = {}) {
    setStamp("chart-stamp", true);
    const cached = loadCachedChart();
    if (cached) {
      try { renderChartFromCache(cached); } catch {}
    }
    const tickerAtStart = state.ticker, rangeAtStart = state.range;
    try {
      const fetchRange = RANGE_FETCH[state.range] || state.range;
      const interval = state.range === "5d" ? "30m" : "1d";
      const { meta, points: fullPoints } = await API.getChart(state.ticker, fetchRange, interval);
      // Falls User in der Zwischenzeit gewechselt hat → verwerfen
      if (state.ticker !== tickerAtStart || state.range !== rangeAtStart) return;
      const { points, pre, fullCloses } = computeIndicatorsSliced(fullPoints, RANGE_DISPLAY_COUNT[state.range]);
      state.lastRender = { meta, points, pre, fullCloses };
      CHARTS.render("price-chart", points, state.ticker, state.indicators, pre);
      updateChartHeaderAndMetrics(meta, points, pre, fullCloses);
      saveCachedChart(state.ticker, state.range, meta, points, pre, fullCloses);
      setStamp("chart-stamp", false);
    } catch (e) {
      console.warn("Chart error", e);
      if (retry > 0 && state.ticker === tickerAtStart && state.range === rangeAtStart) {
        setStamp("chart-stamp", false);
        setTimeout(() => loadChart({ silent, retry: retry - 1 }), 1200);
        return;
      }
      if (!silent && !state.lastRender) $("chart-sub").textContent = "Daten gerade nicht abrufbar — neuer Versuch in 60s.";
      setStamp("chart-stamp", false);
    }
  }

  async function loadNewsSilent(silent) {
    setStamp("news-stamp", true);
    try {
      await NEWS.loadNews($("news-feed"), { silent });
      setStamp("news-stamp", false);
    } catch (e) {
      setStamp("news-stamp", false);
      console.warn("News error", e);
    }
  }

  function selectTicker(sym) {
    state.ticker = sym.toUpperCase();
    $("ticker-input").value = state.ticker;
    state.lastRender = null;
    loadChart();
  }

  function renderScanRow(r) {
    const expDate = new Date(r.expirationDate * 1000).toLocaleDateString("de-DE");
    const premiumStr = r.strategy === "lc" ? `-$${fmt(Math.abs(r.premium))}` : `$${fmt(r.premium)}`;
    return `<tr>
      <td><strong>${r.ticker}</strong></td>
      <td><span class="strat-tag ${r.strategy}">${r.strategyLabel}</span></td>
      <td>${r.setup}</td>
      <td>${expDate}</td>
      <td class="num">${r.dte}</td>
      <td class="num">${premiumStr}</td>
      <td class="num">$${fmt(r.maxRisk)}</td>
      <td class="num">${(r.pop * 100).toFixed(1)}%</td>
      <td class="num">${(r.annRet * 100).toFixed(1)}%</td>
      <td class="num">${(r.score * 100).toFixed(1)}</td>
    </tr>`;
  }

  async function runScan({ silent = false } = {}) {
    if (state.scanRunning) return;
    state.scanRunning = true;
    const status = $("scan-status");
    const body = $("strategies-body");
    setStamp("scan-stamp", true);
    if (!silent) body.innerHTML = "";
    status.className = "scan-status running";
    status.textContent = silent ? "Auto-Scan läuft…" : "Starte Scan…";

    const minPop = (parseFloat($("min-pop").value) || 0) / 100;
    const maxDte = parseInt($("max-dte").value) || 60;
    const sel = $("strategy-select").value;
    const strategies = sel === "all" ? ["csp", "cc", "bps", "lc"] : [sel];

    try {
      const tickers = CFG.SCAN_TICKERS.slice(0, 18);
      const { results, fallback, errors, ok, total } = await STRAT.scan({
        tickers, strategies, minPop, maxDte,
        onProgress: (i, n, t) => { status.textContent = `Scanne ${i}/${n}: ${t}`; },
      });

      const errCount = errors.length;
      if (results.length) {
        status.className = "scan-status";
        status.textContent = `${results.length} Vorschläge (${ok}/${total} Ticker OK${errCount ? `, ${errCount} Fehler` : ""}). Nächster Auto-Scan in 15 Min.`;
        body.innerHTML = results.map(renderScanRow).join("");
      } else if (fallback.length) {
        status.className = "scan-status";
        status.textContent = `Keine Treffer mit Filter (Min-POP ${(minPop*100).toFixed(0)}%) — zeige Top ${fallback.length} unter dem Filter. ${ok}/${total} OK${errCount ? `, ${errCount} Fehler` : ""}.`;
        body.innerHTML = fallback.map(renderScanRow).join("");
      } else if (ok === 0 && errCount > 0) {
        status.className = "scan-status error";
        const sampleErr = errors[0]?.reason || "unbekannt";
        const hint = /HTTP|Proxy|fehlgeschlagen/i.test(sampleErr)
          ? " CORS-Proxy gerade überlastet — bitte nochmal scannen."
          : "";
        status.textContent = `Optionsdaten gerade nicht abrufbar (0/${total} OK). Beispiel: ${sampleErr}.${hint}`;
      } else {
        status.className = "scan-status";
        status.textContent = `${ok}/${total} Ticker gescannt, keine handelbaren Setups gefunden.`;
      }
      setStamp("scan-stamp", false);
    } catch (e) {
      status.className = "scan-status error";
      status.textContent = "Scan-Fehler: " + e.message;
      setStamp("scan-stamp", false);
    } finally {
      state.scanRunning = false;
    }
  }

  function bindUi() {
    $("refresh-btn").addEventListener("click", () => refreshAll(false));
    $("load-ticker-btn").addEventListener("click", () => {
      const v = $("ticker-input").value.trim();
      if (v) selectTicker(v);
    });
    $("ticker-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = e.target.value.trim();
        if (v) selectTicker(v);
      }
    });
    document.querySelectorAll(".range-btn").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".range-btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        state.range = b.dataset.range;
        state.lastRender = null;
        loadChart();
      });
    });
    document.querySelectorAll("#movers-tabs .tab").forEach(t => {
      t.addEventListener("click", () => {
        document.querySelectorAll("#movers-tabs .tab").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        state.moverTab = t.dataset.mover;
        loadMovers();
      });
    });
    $("scan-btn").addEventListener("click", () => runScan({ silent: false }));

    ["sma20", "sma50", "bb"].forEach(key => {
      const cb = $(`ind-${key}`);
      if (!cb) return;
      cb.addEventListener("change", () => {
        const k = key === "bb" ? "bollinger" : key;
        state.indicators[k] = cb.checked;
        if (state.lastRender) {
          CHARTS.render("price-chart", state.lastRender.points, state.ticker, state.indicators, state.lastRender.pre);
        }
      });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopAllTimers();
      else { startAllTimers(); refreshAll(true); }
    });
  }

  async function refreshAll(silent = false) {
    loadChart({ silent });
    await Promise.all([
      loadMarketSummary({ silent }),
      loadMovers({ silent }),
      loadNewsSilent(silent),
    ]);
  }

  function startTimer(name, fn, interval) {
    stopTimer(name);
    state.timers[name] = setInterval(fn, interval);
  }
  function stopTimer(name) {
    if (state.timers[name]) { clearInterval(state.timers[name]); state.timers[name] = null; }
  }
  function stopAllTimers() { Object.keys(state.timers).forEach(stopTimer); }
  function startAllTimers() {
    startTimer("market", () => loadMarketSummary({ silent: true }), INTERVALS.market);
    startTimer("movers", () => loadMovers({ silent: true }), INTERVALS.movers);
    startTimer("chart",  () => loadChart({ silent: true }),  INTERVALS.chart);
    startTimer("news",   () => loadNewsSilent(true),         INTERVALS.news);
    startTimer("scan",   () => runScan({ silent: true }),    INTERVALS.scan);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindUi();
    $("ticker-input").value = state.ticker;
    loadChart({ silent: false });
    loadMarketSummary({ silent: false });
    loadMovers({ silent: false });
    loadNewsSilent(false);
    setTimeout(() => runScan({ silent: false }), SCAN_INITIAL_DELAY);
    startAllTimers();
  });
})();
