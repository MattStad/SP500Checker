(() => {
  const seenLinks = new Set();
  const MARKET_KEYWORDS = /\b(stocks?|market|S&P|SPX|SPY|nasdaq|dow|fed|rate|earnings|inflation|cpi|jobs|gdp|yield|treasury|recession|rally|sell.?off|bull|bear|oil|gold|nvidia|apple|tesla|microsoft|amazon|google|meta|crypto|bitcoin)\b/i;

  function timeAgo(date) {
    const diff = (Date.now() - new Date(date).getTime()) / 1000;
    if (diff < 60) return "gerade eben";
    if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`;
    if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std`;
    return `vor ${Math.floor(diff / 86400)} Tagen`;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  function normalizeKey(item) {
    if (item.link) return item.link.split("?")[0].toLowerCase();
    return (item.title || "").toLowerCase().slice(0, 80);
  }

  function relevanceScore(item) {
    const txt = `${item.title || ""} ${item.description || ""}`;
    let score = 0;
    if (MARKET_KEYWORDS.test(txt)) score += 2;
    const ageMin = (Date.now() - new Date(item.pubDate).getTime()) / 60_000;
    if (ageMin < 60) score += 3;
    else if (ageMin < 180) score += 2;
    else if (ageMin < 360) score += 1;
    return score;
  }

  async function loadNews(container, { silent = false } = {}) {
    if (!silent) container.innerHTML = "Lade…";
    const all = [];
    const results = await Promise.allSettled(
      CFG.RSS_FEEDS.map(async (feed) => {
        const items = await API.getNews(feed.url, 20);
        return items.map(it => ({ ...it, source: feed.name }));
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value);
    }

    const dedup = new Map();
    for (const it of all) {
      const key = normalizeKey(it);
      if (!dedup.has(key)) dedup.set(key, it);
    }

    const items = Array.from(dedup.values())
      .map(it => ({ ...it, _score: relevanceScore(it), _ts: new Date(it.pubDate).getTime() || 0 }))
      .sort((a, b) => (b._score - a._score) || (b._ts - a._ts))
      .slice(0, 40);

    if (!items.length) {
      if (!silent) container.innerHTML = '<div class="news-item">Keine News verfügbar. RSS-Quellen evtl. blockiert.</div>';
      return;
    }

    container.innerHTML = items.map(it => {
      const isNew = !seenLinks.has(it.link);
      seenLinks.add(it.link);
      const ageMin = (Date.now() - it._ts) / 60_000;
      const fresh = ageMin < 60 ? "fresh" : "";
      return `<div class="news-item ${isNew ? "new" : ""} ${fresh}">
        <a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
        <div class="meta">${escapeHtml(it.source)} · ${timeAgo(it.pubDate)}${isNew && silent ? " · <span class=\"new-badge\">NEU</span>" : ""}</div>
      </div>`;
    }).join("");
  }

  window.NEWS = { loadNews };
})();
