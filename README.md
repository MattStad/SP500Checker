# S&P 500 Options Analyzer

Eine reine Browser-App, die den S&P 500 analysiert, Live-Charts mit Metriken rendert, Markt-News anzeigt und Optionsstrategie-Setups (Cash-Secured Puts, Covered Calls, Bull Put Spreads, Long Calls) nach annualisierter Rendite × Probability of Profit rankt.

> ⚠️ **Keine Anlageberatung.** Reines Bildungs-/Screening-Tool. Daten kommen über inoffizielle Endpunkte und können verzögert oder fehlerhaft sein.

## Features

- Live S&P 500 / VIX / 10Y-Treasury Header
- Top-Gainer / Loser / Volumen aus dem S&P 500 Universum
- Interaktiver Preis-Chart mit Volumen, 5T / 1M / 3M / 6M / 1J Ranges
- Live News Feed aus Yahoo Finance, MarketWatch, CNBC (RSS)
- Optionsscreener mit Black-Scholes Greeks, POP, annualisierter Rendite
- Filter nach Strategie, Min-POP, Max-DTE

## Tech-Stack

- Pures HTML / CSS / JavaScript (kein Build-Step)
- Chart.js via CDN
- Yahoo Finance inoffizielle JSON-Endpunkte (via öffentlichem CORS-Proxy)
- `rss2json.com` für News

Keine API-Keys, kein Backend, kein npm install.

## Lokal starten

Browser-Sicherheit blockiert `fetch()` von `file://` — also einen lokalen Server starten:

```bash
# Python 3
python -m http.server 8080

# oder Node
npx serve .
```

Dann `http://localhost:8080` öffnen.

## GitHub Pages Deployment

1. Repo zu GitHub pushen
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main`, Folder: `/ (root)`
3. Nach 1–2 Minuten ist die Seite live unter `https://<user>.github.io/<repo>/`

Die `.nojekyll` Datei sorgt dafür dass Pages die Files unverändert ausliefert.

## Bekannte Limitierungen

- **CORS-Proxies sind unzuverlässig** — wenn `corsproxy.io` ausfällt, gibt es Fallbacks (`allorigins`, `codetabs`). Wenn alle fallen, gehen Daten nicht.
- **Yahoo Endpoints sind inoffiziell** — können sich ohne Warnung ändern.
- **Optionen-Daten sind ~15min verzögert** (Yahoo gratis).
- **Implied Volatility** kommt direkt von Yahoo; Greeks werden client-seitig per Black-Scholes berechnet.
- **POP** ist eine Modellschätzung (Risk-neutral Wahrscheinlichkeit unter Black-Scholes Annahmen) — keine echte Eintrittswahrscheinlichkeit.

## Strategie-Logik

| Strategie | Wann es sich rentiert | Score-Formel |
|---|---|---|
| Cash-Secured Put | Bullish/neutral, willst Aktie eh haben | annRet × POP |
| Covered Call | Aktie bereits im Depot, Income | annRet × POP |
| Bull Put Spread | Bullish mit definiertem Risiko | annRet × POP, beste Kombi aus Top-8 OTM Strikes |
| Long Call | Direktionale Spekulation | annRet × POP × 0.6 (Penalty) |

`annRet = (Prämie / Max-Risiko) × (365 / DTE)`

## Disclaimer

Dies ist eine technische Demo und kein Finanzprodukt. Der Autor übernimmt keine Haftung für Handelsverluste. Optionshandel beinhaltet erhebliche Risiken — auch Totalverlust.
