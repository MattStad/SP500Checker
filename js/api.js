(() => {
  const Y_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
  const Y_OPTIONS = "https://query2.finance.yahoo.com/v7/finance/options";
  const RSS2JSON = "https://api.rss2json.com/v1/api.json";

  // Merkt sich den zuletzt funktionierenden Proxy → wird beim nächsten Mal zuerst probiert
  let bestProxyIdx = 0;

  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Probiert Proxies in Reihenfolge, beginnend beim zuletzt erfolgreichen.
  // Gibt den extrahierten Text zurück. Bei Timeout/Fehler → nächster Proxy.
  async function fetchRawViaProxy(url) {
    const proxies = CFG.CORS_PROXIES;
    const order = [bestProxyIdx, ...proxies.map((_, i) => i).filter(i => i !== bestProxyIdx)];
    let lastErr;
    for (const idx of order) {
      const proxy = proxies[idx];
      try {
        const res = await fetchWithTimeout(proxy.build(url), CFG.PROXY_TIMEOUT_MS);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const raw = await res.text();
        const text = proxy.extract(raw);
        if (!text || text.length < 10) throw new Error("Leere Antwort");
        bestProxyIdx = idx; // dieser Proxy klappt → nächstes Mal zuerst
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Alle Proxies fehlgeschlagen");
  }

  async function fetchViaProxy(url) {
    const text = await fetchRawViaProxy(url);
    try { return JSON.parse(text); } catch { return text; }
  }

  async function fetchTextViaProxy(url) {
    const text = await fetchRawViaProxy(url);
    if (text.length < 30) throw new Error("Leere Antwort");
    return text;
  }

  async function getChartRaw(symbol, range = "1mo", interval = "1d") {
    const url = `${Y_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const data = await fetchViaProxy(url);
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error("Keine Daten für " + symbol);
    return r;
  }

  async function getChart(symbol, range = "1mo", interval = "1d") {
    const r = await getChartRaw(symbol, range, interval);
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const points = ts.map((t, i) => ({
      t: new Date(t * 1000),
      o: q.open?.[i], h: q.high?.[i], l: q.low?.[i],
      c: q.close?.[i], v: q.volume?.[i],
    })).filter(p => p.c != null);
    return { meta: r.meta, points };
  }

  const Y_SPARK = "https://query1.finance.yahoo.com/v7/finance/spark";

  function metaToQuote(m, fallbackSymbol) {
    const price = m.regularMarketPrice;
    if (price == null) return null;
    // previousClose = gestriger Schluss (korrekt für Tagesänderung)
    const prev = m.previousClose ?? m.chartPreviousClose;
    return {
      symbol: m.symbol || fallbackSymbol,
      regularMarketPrice: price,
      regularMarketChangePercent: prev ? ((price - prev) / prev) * 100 : 0,
      regularMarketChange: prev ? (price - prev) : 0,
      regularMarketVolume: m.regularMarketVolume,
      regularMarketPreviousClose: prev,
      fiftyTwoWeekHigh: m.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: m.fiftyTwoWeekLow,
      currency: m.currency,
    };
  }

  // Spark batcht VIELE Symbole in EINE Anfrage → drastisch weniger Proxy-Last
  async function getSparkChunk(symbols) {
    const url = `${Y_SPARK}?symbols=${encodeURIComponent(symbols.join(","))}&range=1d&interval=5m`;
    const data = await fetchViaProxy(url);
    const results = data?.spark?.result || [];
    const out = [];
    for (const r of results) {
      const resp = r?.response?.[0];
      const m = resp?.meta;
      if (m) {
        const q = metaToQuote(m, r.symbol);
        if (q) {
          // Intraday-Kursreihe für Mini-Sparkline mitnehmen (kostet nichts extra)
          const closes = (resp.indicators?.quote?.[0]?.close || []).filter(v => v != null);
          q.spark = closes;
          out.push(q);
        }
      }
    }
    return out;
  }

  async function getQuotes(symbols, onChunk) {
    const chunkSize = 15; // kleinere Chunks → erste Ergebnisse erscheinen schneller
    const chunks = [];
    for (let i = 0; i < symbols.length; i += chunkSize) {
      chunks.push(symbols.slice(i, i + chunkSize));
    }
    const out = [];
    // Chunks parallel starten; onChunk feuert sobald ein Chunk fertig ist (progressiv)
    await Promise.all(chunks.map(async (chunk) => {
      try {
        const part = await getSparkChunk(chunk);
        out.push(...part);
        onChunk?.(out.slice());
      } catch (e) { /* einzelner Chunk fehlgeschlagen → Rest läuft weiter */ }
    }));
    // Fallback: wenn Spark komplett scheitert, einzelner Chart-Call (langsam, selten)
    if (!out.length && symbols.length) {
      const r = await getChartRaw(symbols[0], "5d", "1d").catch(() => null);
      if (r?.meta) { const q = metaToQuote(r.meta, symbols[0]); if (q) out.push(q); }
    }
    return out;
  }

  // ---- CBOE: kostenlose verzögerte Optionsdaten (IV + Greeks, kein Key) ----
  const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/";

  function parseOcc(sym) {
    // z.B. AAPL260617C00230000 → root, exp(unix), type, strike
    const strike = parseInt(sym.slice(-8), 10) / 1000;
    const type = sym.slice(-9, -8) === "C" ? "call" : "put";
    const ds = sym.slice(-15, -9); // YYMMDD
    const yy = 2000 + parseInt(ds.slice(0, 2), 10);
    const mm = parseInt(ds.slice(2, 4), 10);
    const dd = parseInt(ds.slice(4, 6), 10);
    const exp = Math.floor(Date.UTC(yy, mm - 1, dd, 20, 0, 0) / 1000);
    return { type, strike, exp };
  }

  function cboeSymbol(symbol) {
    // CBOE nutzt keine Bindestriche (BRK-B → BRKB)
    return symbol.replace(/[-.]/g, "");
  }

  async function getCboeChain(symbol) {
    const url = CBOE + encodeURIComponent(cboeSymbol(symbol)) + ".json";
    const data = await fetchViaProxy(url);
    const d = data?.data;
    if (!d || !Array.isArray(d.options)) throw new Error("Keine CBOE-Daten für " + symbol);
    const price = d.current_price ?? d.close ?? d.prev_day_close;
    if (price == null) throw new Error("Kein Preis für " + symbol);

    const byExp = new Map();
    for (const o of d.options) {
      const p = parseOcc(o.option);
      if (!byExp.has(p.exp)) byExp.set(p.exp, { calls: [], puts: [] });
      const leg = {
        strike: p.strike,
        bid: o.bid || 0,
        ask: o.ask || 0,
        lastPrice: o.last_trade_price || 0,
        impliedVolatility: o.iv || 0,
        volume: o.volume || 0,
        openInterest: o.open_interest || 0,
        delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega,
        expiration: p.exp,
      };
      byExp.get(p.exp)[p.type === "call" ? "calls" : "puts"].push(leg);
    }
    const expirations = Array.from(byExp.keys()).sort((a, b) => a - b);
    return { price, expirations, byExp };
  }

  async function getOptionExpirations(symbol) {
    const url = `${Y_OPTIONS}/${encodeURIComponent(symbol)}`;
    const data = await fetchViaProxy(url);
    const r = data?.optionChain?.result?.[0];
    if (!r) throw new Error("Keine Optionsdaten für " + symbol);
    return {
      expirations: r.expirationDates || [],
      underlying: r.quote,
      firstChain: r.options?.[0],
    };
  }

  async function getOptionChain(symbol, expirationUnix) {
    const url = `${Y_OPTIONS}/${encodeURIComponent(symbol)}?date=${expirationUnix}`;
    const data = await fetchViaProxy(url);
    const r = data?.optionChain?.result?.[0];
    if (!r) throw new Error("Keine Optionskette für " + symbol);
    return {
      underlying: r.quote,
      chain: r.options?.[0],
    };
  }

  async function getNewsViaXml(rssUrl) {
    const buster = Math.floor(Date.now() / 60_000);
    const urlWithBuster = rssUrl + (rssUrl.includes("?") ? "&" : "?") + `_=${buster}`;
    const text = await fetchTextViaProxy(urlWithBuster);
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML Parse Error");
    let items = Array.from(doc.querySelectorAll("item")).map(i => ({
      title: i.querySelector("title")?.textContent?.trim() || "",
      link: i.querySelector("link")?.textContent?.trim() || "",
      pubDate: i.querySelector("pubDate")?.textContent || new Date().toISOString(),
      description: i.querySelector("description")?.textContent || "",
    }));
    if (!items.length) {
      items = Array.from(doc.querySelectorAll("entry")).map(e => ({
        title: e.querySelector("title")?.textContent?.trim() || "",
        link: e.querySelector("link")?.getAttribute("href") || e.querySelector("link")?.textContent?.trim() || "",
        pubDate: e.querySelector("published")?.textContent || e.querySelector("updated")?.textContent || new Date().toISOString(),
        description: e.querySelector("summary")?.textContent || e.querySelector("content")?.textContent || "",
      }));
    }
    items = items.filter(x => x.title && x.link);
    if (!items.length) throw new Error("Keine Items im Feed");
    return items;
  }

  async function getNewsViaRss2Json(rssUrl, count = 20) {
    const buster = Math.floor(Date.now() / 60_000);
    const url = `${RSS2JSON}?rss_url=${encodeURIComponent(rssUrl)}&count=${count}&_=${buster}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.status !== "ok") throw new Error(data.message || "RSS parse failed");
    return data.items || [];
  }

  async function getNews(rssUrl, count = 20) {
    try {
      const items = await getNewsViaXml(rssUrl);
      return items.slice(0, count);
    } catch (eXml) {
      const items = await getNewsViaRss2Json(rssUrl, count);
      return items;
    }
  }

  window.API = { getQuotes, getChart, getChartRaw, getOptionExpirations, getOptionChain, getCboeChain, getNews };
})();
