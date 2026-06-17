(() => {
  const Y_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
  const Y_OPTIONS = "https://query2.finance.yahoo.com/v7/finance/options";
  const RSS2JSON = "https://api.rss2json.com/v1/api.json";

  async function fetchViaProxy(url) {
    let lastErr;
    for (const proxify of CFG.CORS_PROXIES) {
      try {
        const res = await fetch(proxify(url), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("All proxies failed");
  }

  async function fetchTextViaProxy(url) {
    let lastErr;
    for (const proxify of CFG.CORS_PROXIES) {
      try {
        const res = await fetch(proxify(url), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        if (!text || text.length < 30) throw new Error("Leere Antwort");
        return text;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("All proxies failed");
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

  async function getQuotes(symbols) {
    const chunkSize = CFG.QUOTE_CHUNK_SIZE || 10;
    const out = [];
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      const results = await Promise.all(chunk.map(async (s) => {
        try {
          const r = await getChartRaw(s, "5d", "1d");
          const m = r.meta || {};
          const price = m.regularMarketPrice;
          // previousClose = gestriger Schluss (korrekt für Tagesänderung);
          // chartPreviousClose = Schluss VOR dem 5T-Fenster (falsch für Tagesänderung)
          const prev = m.previousClose ?? m.chartPreviousClose;
          if (price == null) return null;
          return {
            symbol: m.symbol || s,
            regularMarketPrice: price,
            regularMarketChangePercent: prev ? ((price - prev) / prev) * 100 : 0,
            regularMarketChange: prev ? (price - prev) : 0,
            regularMarketVolume: m.regularMarketVolume,
            regularMarketPreviousClose: prev,
            currency: m.currency,
          };
        } catch (e) {
          return null;
        }
      }));
      out.push(...results.filter(Boolean));
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
