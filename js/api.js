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
          const prev = m.chartPreviousClose ?? m.previousClose;
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

  async function getNews(rssUrl, count = 15) {
    const buster = Math.floor(Date.now() / 60_000);
    const url = `${RSS2JSON}?rss_url=${encodeURIComponent(rssUrl)}&count=${count}&_=${buster}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("News fetch failed: " + res.status);
    const data = await res.json();
    if (data.status !== "ok") throw new Error("RSS parse failed");
    return data.items || [];
  }

  window.API = { getQuotes, getChart, getChartRaw, getOptionExpirations, getOptionChain, getNews };
})();
