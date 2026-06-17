window.CFG = {
  CORS_PROXIES: [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  ],
  RISK_FREE_RATE: 0.045,
  SCAN_TICKERS: [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK-B","JPM","V",
    "MA","UNH","XOM","JNJ","WMT","PG","HD","COST","BAC","ABBV",
    "ORCL","CRM","AMD","NFLX","ADBE","KO","PEP","MCD","DIS","CSCO",
    "INTC","T","VZ","CVX","WFC","NKE","BA","GE","CAT","GS",
    "MS","C","PFE","MRK","TGT","LOW","QCOM","AVGO","IBM","SPY"
  ],
  RSS_FEEDS: [
    { name: "Yahoo S&P500", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US" },
    { name: "Yahoo Top", url: "https://finance.yahoo.com/news/rssindex" },
    { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
    { name: "MarketWatch Real-time", url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines" },
    { name: "CNBC Markets", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html" },
    { name: "CNBC Business", url: "https://www.cnbc.com/id/10001147/device/rss/rss.html" },
    { name: "Investing News", url: "https://www.investing.com/rss/news_25.rss" },
    { name: "Investing Stocks", url: "https://www.investing.com/rss/stock.rss" },
    { name: "SeekingAlpha", url: "https://seekingalpha.com/market_currents.xml" },
  ],
  DEFAULT_TICKER: "SPY",
  QUOTE_CHUNK_SIZE: 10,
  CHART_CACHE_TTL_MS: 5 * 60_000,
};
