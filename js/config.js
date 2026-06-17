window.CFG = {
  // Reihenfolge nach Zuverlässigkeit. corsproxy.io ist aktuell am schnellsten.
  // extract: manche Proxies (allorigins/get) verpacken die Antwort in JSON.
  CORS_PROXIES: [
    {
      build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
      extract: (text) => text,
    },
    {
      build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      extract: (text) => text,
    },
    {
      build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      extract: (text) => {
        try { return JSON.parse(text).contents ?? text; } catch { return text; }
      },
    },
    {
      build: (url) => `https://api.codetabs.com/v1/proxy/?quest=${url}`,
      extract: (text) => text,
    },
  ],
  PROXY_TIMEOUT_MS: 12_000,
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
  TICKER_NAMES: {
    AAPL:"Apple", MSFT:"Microsoft", NVDA:"NVIDIA", AMZN:"Amazon", GOOGL:"Alphabet",
    META:"Meta", TSLA:"Tesla", "BRK-B":"Berkshire H.", JPM:"JPMorgan", V:"Visa",
    MA:"Mastercard", UNH:"UnitedHealth", XOM:"Exxon Mobil", JNJ:"Johnson & J.", WMT:"Walmart",
    PG:"Procter & G.", HD:"Home Depot", COST:"Costco", BAC:"Bank of America", ABBV:"AbbVie",
    ORCL:"Oracle", CRM:"Salesforce", AMD:"AMD", NFLX:"Netflix", ADBE:"Adobe",
    KO:"Coca-Cola", PEP:"PepsiCo", MCD:"McDonald's", DIS:"Disney", CSCO:"Cisco",
    INTC:"Intel", T:"AT&T", VZ:"Verizon", CVX:"Chevron", WFC:"Wells Fargo",
    NKE:"Nike", BA:"Boeing", GE:"GE Aerospace", CAT:"Caterpillar", GS:"Goldman Sachs",
    MS:"Morgan Stanley", C:"Citigroup", PFE:"Pfizer", MRK:"Merck", TGT:"Target",
    LOW:"Lowe's", QCOM:"Qualcomm", AVGO:"Broadcom", IBM:"IBM", SPY:"S&P 500 ETF"
  },
  DEFAULT_TICKER: "SPY",
  QUOTE_CHUNK_SIZE: 10,
  CHART_CACHE_TTL_MS: 5 * 60_000,
};
