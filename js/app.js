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
  // Anzeige-Fenster in Tagen (echte Kalendertage, robust gegen Bar-Intervall)
  const RANGE_DISPLAY_DAYS = { "5d": 7, "1mo": 31, "3mo": 93, "6mo": 187, "1y": 372 };

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
    scanDisplayed: [],
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
  const fmtVol = (n) => {
    if (n == null || isNaN(n)) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(n);
  };

  // Mini-Sparkline aus Intraday-Closes als kompaktes SVG
  function sparklineSvg(closes, up) {
    if (!closes || closes.length < 2) return `<svg class="mv-spark" viewBox="0 0 80 28"></svg>`;
    const w = 80, h = 28, pad = 2;
    const min = Math.min(...closes), max = Math.max(...closes);
    const range = max - min || 1;
    const n = closes.length;
    const pts = closes.map((c, i) => {
      const x = pad + (i / (n - 1)) * (w - 2 * pad);
      const y = pad + (1 - (c - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const color = up ? "var(--up)" : "var(--down)";
    const lastY = pts[pts.length - 1].split(",")[1];
    const areaPts = `${pad},${h - pad} ${pts.join(" ")} ${w - pad},${h - pad}`;
    const gid = "g" + Math.random().toString(36).slice(2, 8);
    return `<svg class="mv-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${areaPts}" fill="url(#${gid})"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="${(w - pad).toFixed(1)}" cy="${lastY}" r="1.6" fill="${color}"/>
    </svg>`;
  }

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
  function saveCachedChart(sym, range, meta, points, pre, fullCloses, quote) {
    try {
      localStorage.setItem(cacheChartKey(sym, range), JSON.stringify({
        ts: Date.now(), meta, pre, fullCloses, quote,
        points: points.map(p => ({ ...p, t: p.t.toISOString() })),
      }));
    } catch {}
  }

  function computeIndicatorsSliced(fullPoints, displayDays) {
    const closes = fullPoints.map(p => p.c);
    const sma20Full = IND.sma(closes, 20);
    const sma50Full = IND.sma(closes, 50);
    const bbFull = IND.bollinger(closes, 20, 2);
    // Slicing nach echtem Datum: zeige nur Punkte innerhalb des Anzeige-Fensters
    let startIdx = 0;
    if (displayDays && fullPoints.length) {
      const lastT = fullPoints[fullPoints.length - 1].t.getTime();
      const cutoff = lastT - displayDays * 86_400_000;
      startIdx = fullPoints.findIndex(p => p.t.getTime() >= cutoff);
      if (startIdx < 0) startIdx = 0;
    }
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

  function renderMovers(quotes, kind) {
    const list = $("movers-list");
    let sorted = quotes.filter(q => q.regularMarketPrice != null);
    if (kind === "gainers") sorted.sort((a, b) => (b.regularMarketChangePercent || 0) - (a.regularMarketChangePercent || 0));
    else if (kind === "losers") sorted.sort((a, b) => (a.regularMarketChangePercent || 0) - (b.regularMarketChangePercent || 0));
    else sorted.sort((a, b) => (b.regularMarketVolume || 0) - (a.regularMarketVolume || 0));
    sorted = sorted.slice(0, 20);
    state.lastMovers = sorted;
    list.innerHTML = sorted.map((q, i) => {
      const chg = q.regularMarketChangePercent || 0;
      const cls = chg >= 0 ? "up" : "down";
      const sign = chg >= 0 ? "+" : "";
      const name = CFG.TICKER_NAMES[q.symbol] || "";
      const spark = sparklineSvg(q.spark, chg >= 0);
      return `<div class="mover-row" data-sym="${q.symbol}">
        <span class="mv-rank">${i + 1}</span>
        <div class="mv-id">
          <span class="sym">${q.symbol}</span>
          <span class="mv-name">${name}</span>
        </div>
        ${spark}
        <div class="mv-num">
          <span class="price">$${fmt(q.regularMarketPrice)}</span>
          <span class="chg ${cls}">${sign}${chg.toFixed(2)}%</span>
          <span class="mv-vol">Vol ${fmtVol(q.regularMarketVolume)}</span>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".mover-row").forEach(row => {
      row.addEventListener("click", () => selectTicker(row.dataset.sym));
    });
    return sorted;
  }

  async function loadMovers({ silent = false, kind = state.moverTab } = {}) {
    const list = $("movers-list");
    setStamp("movers-stamp", true);
    if (!silent && !list.querySelector(".mover-row")) list.innerHTML = "Lade…";
    try {
      // Progressiv rendern: jeder fertige Chunk aktualisiert die Liste sofort
      let quotes = await API.getQuotes(CFG.SCAN_TICKERS, (partial) => {
        if (partial.length >= 5) renderMovers(partial, kind);
      });
      if (quotes.length < 5 && state.lastQuotes.length) {
        quotes = state.lastQuotes;
      } else if (quotes.length >= 5) {
        state.lastQuotes = quotes;
      }
      if (!quotes.length) throw new Error("Keine Quotes erhalten (Proxy evtl. überlastet)");
      const sorted = renderMovers(quotes, kind);
      setStamp("movers-stamp", false);
      prefetchMoverCharts(sorted.slice(0, 6));
    } catch (e) {
      console.warn("Movers error", e);
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
        const { points, pre, fullCloses } = computeIndicatorsSliced(fullPoints, RANGE_DISPLAY_DAYS["1mo"]);
        saveCachedChart(m.symbol, "1mo", meta, points, pre, fullCloses);
      } catch (e) {
        console.debug("Prefetch fehlgeschlagen", m.symbol);
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  function renderChartFromCache(cached) {
    state.lastRender = { meta: cached.meta, points: cached.points, pre: cached.pre, fullCloses: cached.fullCloses, quote: cached.quote };
    CHARTS.render("price-chart", cached.points, state.ticker, state.indicators, cached.pre);
    updateChartHeaderAndMetrics(cached.meta, cached.points, cached.pre, cached.fullCloses, cached.quote);
  }

  function updateChartHeaderAndMetrics(meta, points, pre, fullCloses, quote) {
    $("chart-title").textContent = state.ticker;
    // Chart-Meta hat kein previousClose → nutze spark-Quote für korrekte Tagesänderung
    const price = quote?.regularMarketPrice ?? meta.regularMarketPrice;
    const prev = quote?.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
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
      <div class="metric-cell"><span class="k">52W Hoch</span><span class="v">$${fmt(quote?.fiftyTwoWeekHigh ?? meta.fiftyTwoWeekHigh)}</span></div>
      <div class="metric-cell"><span class="k">52W Tief</span><span class="v">$${fmt(quote?.fiftyTwoWeekLow ?? meta.fiftyTwoWeekLow)}</span></div>
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
      // Chart + Quote parallel — Quote liefert korrekten previousClose (Tagesänderung)
      const [chartData, quotes] = await Promise.all([
        API.getChart(state.ticker, fetchRange, interval),
        API.getQuotes([state.ticker]).catch(() => []),
      ]);
      const { meta, points: fullPoints } = chartData;
      const quote = quotes[0];
      // Falls User in der Zwischenzeit gewechselt hat → verwerfen
      if (state.ticker !== tickerAtStart || state.range !== rangeAtStart) return;
      const { points, pre, fullCloses } = computeIndicatorsSliced(fullPoints, RANGE_DISPLAY_DAYS[state.range]);
      state.lastRender = { meta, points, pre, fullCloses, quote };
      CHARTS.render("price-chart", points, state.ticker, state.indicators, pre);
      updateChartHeaderAndMetrics(meta, points, pre, fullCloses, quote);
      saveCachedChart(state.ticker, state.range, meta, points, pre, fullCloses, quote);
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

  function renderScanRow(r, idx) {
    const expDate = new Date(r.expirationDate * 1000).toLocaleDateString("de-DE");
    const premiumStr = r.strategy === "lc" ? `-$${fmt(Math.abs(r.premium))}` : `$${fmt(r.premium)}`;
    return `<tr data-idx="${idx}" title="Klicken für Payoff-Diagramm">
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
      const tickers = CFG.SCAN_TICKERS; // alle Ticker scannen
      const { results, fallback, errors, ok, total } = await STRAT.scan({
        tickers, strategies, minPop, maxDte,
        onProgress: (i, n, t) => { status.textContent = `Scanne ${i}/${n}: ${t}`; },
      });

      const errCount = errors.length;
      if (results.length) {
        status.className = "scan-status";
        status.textContent = `${results.length} Vorschläge (${ok}/${total} Ticker OK${errCount ? `, ${errCount} Fehler` : ""}). Nächster Auto-Scan in 15 Min.`;
        state.scanDisplayed = results;
        body.innerHTML = results.map(renderScanRow).join("");
      } else if (fallback.length) {
        status.className = "scan-status";
        status.textContent = `Keine Treffer mit Filter (Min-POP ${(minPop*100).toFixed(0)}%) — zeige Top ${fallback.length} unter dem Filter. ${ok}/${total} OK${errCount ? `, ${errCount} Fehler` : ""}.`;
        state.scanDisplayed = fallback;
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

  // ---- Payoff-Diagramm (Gewinn/Verlust bei Verfall) ----
  let payoffChart = null;

  function payoffAt(r, ST) {
    const prem = r.premium;            // Dollar-Betrag (negativ bei Long Call)
    const K = r.strike;
    switch (r.strategy) {
      case "csp": // Short Put + Cash
        return prem - 100 * Math.max(0, K - ST);
      case "cc":  // 100 Aktien + Short Call
        return 100 * (Math.min(ST, K) - r.underlying) + prem;
      case "bps": // Short Put K + Long Put longStrike
        return prem - 100 * Math.max(0, K - ST) + 100 * Math.max(0, r.longStrike - ST);
      case "lc":  // Long Call (prem ist negativ = Kosten)
        return 100 * Math.max(0, ST - K) + prem;
      default: return 0;
    }
  }

  function breakeven(r) {
    const pps = r.premiumPerShare;
    switch (r.strategy) {
      case "csp": return r.strike - pps;
      case "cc":  return r.underlying - pps;
      case "bps": return r.strike - pps;
      case "lc":  return r.strike + pps;
      default: return r.underlying;
    }
  }

  const EXPLAIN = {
    csp: (r) => `<strong>Cash-Secured Put:</strong> Du verkaufst einen Put zum Strike $${fmt(r.strike)} und hinterlegst $${fmt(r.strike*100)} Cash. Du kassierst $${fmt(r.premium)} Prämie. Bleibt der Kurs über $${fmt(r.strike)}, behältst du die Prämie. Fällt er darunter, kaufst du 100 Aktien zu $${fmt(r.strike)} (effektiv ab $${fmt(breakeven(r))} Break-Even). <strong>Bullish/neutral.</strong>`,
    cc:  (r) => `<strong>Covered Call:</strong> Du besitzt 100 Aktien (Kauf bei $${fmt(r.underlying)}) und verkaufst einen Call zum Strike $${fmt(r.strike)} für $${fmt(r.premium)}. Maximaler Gewinn, wenn der Kurs bis $${fmt(r.strike)} steigt; darüber wird verkauft. Schützt leicht nach unten (Break-Even $${fmt(breakeven(r))}). <strong>Neutral/leicht bullish, Income.</strong>`,
    bps: (r) => `<strong>Bull Put Spread:</strong> Verkaufe Put $${fmt(r.strike)}, kaufe Put $${fmt(r.longStrike)} zur Absicherung. Netto-Kredit $${fmt(r.premium)}. Maximaler Verlust gedeckelt auf $${fmt(r.maxRisk)}. Gewinn, solange der Kurs über $${fmt(breakeven(r))} bleibt. <strong>Bullish mit definiertem Risiko.</strong>`,
    lc:  (r) => `<strong>Long Call:</strong> Du kaufst einen Call zum Strike $${fmt(r.strike)} für $${fmt(Math.abs(r.premium))}. Verlust auf die Prämie begrenzt, Gewinn ab $${fmt(breakeven(r))} unbegrenzt nach oben. <strong>Stark bullish, Spekulation.</strong>`,
  };

  function openPayoff(r) {
    const S = r.underlying;
    const be = breakeven(r);
    const lo = Math.min(S * 0.75, r.strike * 0.9, (r.longStrike || S) * 0.9);
    const hi = Math.max(S * 1.25, r.strike * 1.1);
    const N = 90;
    const xs = [], ys = [];
    for (let i = 0; i <= N; i++) {
      const ST = lo + (hi - lo) * (i / N);
      xs.push(ST); ys.push(payoffAt(r, ST));
    }
    const maxProfit = Math.max(...ys), maxLoss = Math.min(...ys);

    $("payoff-title").textContent = `${r.ticker} · ${r.strategyLabel}`;
    $("payoff-sub").textContent = `${r.setup} · Verfall ${new Date(r.expirationDate*1000).toLocaleDateString("de-DE")} (${r.dte} Tage)`;

    const profitCap = r.strategy === "lc" ? "unbegrenzt" : `$${fmt(maxProfit)}`;
    $("payoff-metrics").innerHTML = `
      <div class="metric-cell"><span class="k">Max Gewinn</span><span class="v up">${profitCap}</span></div>
      <div class="metric-cell"><span class="k">Max Verlust</span><span class="v down">$${fmt(Math.abs(maxLoss))}</span></div>
      <div class="metric-cell"><span class="k">Break-Even</span><span class="v">$${fmt(be)}</span></div>
      <div class="metric-cell"><span class="k">Akt. Kurs</span><span class="v">$${fmt(S)}</span></div>
      <div class="metric-cell"><span class="k">POP</span><span class="v">${(r.pop*100).toFixed(1)}%</span></div>
      <div class="metric-cell"><span class="k">Ann. Rendite</span><span class="v">${(r.annRet*100).toFixed(1)}%</span></div>
    `;
    $("payoff-explain").innerHTML = (EXPLAIN[r.strategy] || (() => ""))(r);

    drawPayoffChart(xs, ys, S, be, r);

    const overlay = $("payoff-overlay");
    overlay.hidden = false;
    state.payoffTicker = r.ticker;
  }

  function drawPayoffChart(xs, ys, S, be, r) {
    const ctx = document.getElementById("payoff-chart").getContext("2d");
    if (payoffChart) payoffChart.destroy();
    const zeroLine = xs.map(() => 0);
    payoffChart = new Chart(ctx, {
      data: {
        labels: xs.map(x => "$" + Math.round(x)),
        datasets: [
          {
            type: "line", label: "Gewinn/Verlust", data: ys,
            borderColor: "#60a5fa", borderWidth: 2, pointRadius: 0, tension: 0.05,
            segment: { borderColor: (c) => (c.p0.parsed.y >= 0 && c.p1.parsed.y >= 0) ? "#22c55e" : "#ef4444" },
            fill: { target: { value: 0 }, above: "rgba(34,197,94,0.12)", below: "rgba(239,68,68,0.12)" },
            order: 2,
          },
          { type: "line", label: "Null", data: zeroLine, borderColor: "rgba(138,152,179,0.5)", borderWidth: 1, borderDash: [4,4], pointRadius: 0, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#131b2a", borderColor: "#243049", borderWidth: 1,
            titleColor: "#e5ecf6", bodyColor: "#e5ecf6",
            callbacks: {
              title: (items) => `Kurs bei Verfall: ${items[0].label}`,
              label: (c) => c.dataset.label === "Null" ? null : `G/V: ${c.parsed.y >= 0 ? "+" : ""}$${fmt(c.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: "#8a98b3", maxTicksLimit: 8 }, grid: { color: "rgba(36,48,73,0.4)" }, title: { display: true, text: "Kurs bei Verfall", color: "#8a98b3" } },
          y: { ticks: { color: "#8a98b3", callback: (v) => `$${v}` }, grid: { color: "rgba(36,48,73,0.4)" }, title: { display: true, text: "Gewinn / Verlust", color: "#8a98b3" } },
        },
      },
    });
  }

  function closePayoff() {
    $("payoff-overlay").hidden = true;
    if (payoffChart) { payoffChart.destroy(); payoffChart = null; }
  }

  function bindUi() {
    $("refresh-btn").addEventListener("click", () => refreshAll(false));
    $("strategies-body").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-idx]");
      if (!tr) return;
      const r = state.scanDisplayed[parseInt(tr.dataset.idx, 10)];
      if (r) openPayoff(r);
    });
    $("payoff-close").addEventListener("click", closePayoff);
    $("payoff-overlay").addEventListener("click", (e) => { if (e.target.id === "payoff-overlay") closePayoff(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePayoff(); });
    $("payoff-load-chart").addEventListener("click", () => { if (state.payoffTicker) { selectTicker(state.payoffTicker); closePayoff(); } });
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
