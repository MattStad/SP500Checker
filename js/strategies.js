(() => {
  const DAY_MS = 86_400_000;

  function dteFrom(expirationUnix) {
    return Math.max(1, Math.round((expirationUnix * 1000 - Date.now()) / DAY_MS));
  }
  function annualize(returnPct, dte) { return (returnPct * 365) / dte; }
  function mid(bid, ask, last) {
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return last || bid || ask || 0;
  }

  function cashSecuredPut(ticker, S, put, dte, r) {
    const K = put.strike;
    const premium = mid(put.bid, put.ask, put.lastPrice);
    if (premium <= 0 || K >= S) return null;
    const collateral = K * 100;
    const premiumDollar = premium * 100;
    const maxLoss = collateral - premiumDollar;
    const T = dte / 365;
    const sigma = put.impliedVolatility || 0.3;
    const pop = 1 - BS.probITM("put", S, K, T, r, sigma);
    const retPct = premiumDollar / maxLoss;
    const annRet = annualize(retPct, dte);
    const score = annRet * pop;
    return {
      ticker, strategy: "csp", strategyLabel: "Cash-Secured Put",
      setup: `Verkaufe ${K}P @ ${premium.toFixed(2)}`,
      strike: K, premium: premiumDollar, maxRisk: maxLoss,
      dte, pop, annRet, score, iv: sigma,
      expirationDate: put.expiration,
      underlying: S, premiumPerShare: premium,
    };
  }

  function coveredCall(ticker, S, call, dte, r) {
    const K = call.strike;
    const premium = mid(call.bid, call.ask, call.lastPrice);
    if (premium <= 0 || K <= S) return null;
    const cost = S * 100;
    const premiumDollar = premium * 100;
    const upside = (K - S) * 100 + premiumDollar;
    const T = dte / 365;
    const sigma = call.impliedVolatility || 0.3;
    // Echte Gewinnwahrscheinlichkeit: Kurs bleibt über Break-Even (Einstand − Prämie)
    const breakeven = S - premium;
    const pop = BS.probITM("call", S, breakeven, T, r, sigma);
    const retPct = upside / cost;
    const annRet = annualize(retPct, dte);
    const score = annRet * pop;
    return {
      ticker, strategy: "cc", strategyLabel: "Covered Call",
      setup: `100 Aktien + Verkaufe ${K}C @ ${premium.toFixed(2)}`,
      strike: K, premium: premiumDollar, maxRisk: cost - premiumDollar,
      dte, pop, annRet, score, iv: sigma,
      expirationDate: call.expiration,
      underlying: S, premiumPerShare: premium,
    };
  }

  function bullPutSpread(ticker, S, puts, dte, r) {
    if (!puts || puts.length < 2) return null;
    const otmPuts = puts.filter(p => p.strike < S && (p.bid > 0 || p.ask > 0))
                        .sort((a, b) => b.strike - a.strike);
    if (otmPuts.length < 2) return null;
    let best = null;
    for (let i = 0; i < Math.min(8, otmPuts.length); i++) {
      const shortLeg = otmPuts[i];
      for (let j = i + 1; j < Math.min(i + 6, otmPuts.length); j++) {
        const longLeg = otmPuts[j];
        const width = shortLeg.strike - longLeg.strike;
        if (width <= 0) continue;
        const credit = mid(shortLeg.bid, shortLeg.ask, shortLeg.lastPrice)
                     - mid(longLeg.bid, longLeg.ask, longLeg.lastPrice);
        if (credit <= 0.05) continue;
        const maxLoss = (width - credit) * 100;
        const creditDollar = credit * 100;
        if (maxLoss <= 0) continue;
        const T = dte / 365;
        const sigma = shortLeg.impliedVolatility || 0.3;
        const pop = 1 - BS.probITM("put", S, shortLeg.strike - credit, T, r, sigma);
        const retPct = creditDollar / maxLoss;
        const annRet = annualize(retPct, dte);
        const score = annRet * pop;
        if (!best || score > best.score) {
          best = {
            ticker, strategy: "bps", strategyLabel: "Bull Put Spread",
            setup: `Verkaufe ${shortLeg.strike}P / Kaufe ${longLeg.strike}P (Kredit ${credit.toFixed(2)})`,
            strike: shortLeg.strike, premium: creditDollar, maxRisk: maxLoss,
            dte, pop, annRet, score, iv: sigma,
            expirationDate: shortLeg.expiration,
            underlying: S, longStrike: longLeg.strike, premiumPerShare: credit,
          };
        }
      }
    }
    return best;
  }

  function longCall(ticker, S, call, dte, r) {
    const K = call.strike;
    const premium = mid(call.bid, call.ask, call.lastPrice);
    if (premium <= 0) return null;
    if (K < S * 0.97 || K > S * 1.10) return null;
    const cost = premium * 100;
    const T = dte / 365;
    const sigma = call.impliedVolatility || 0.3;
    const breakeven = K + premium;
    // Gewinn bei Long Call wenn ST > Break-Even → POP = P(ST > BE) = probITM("call", BE)
    const popBreakeven = BS.probITM("call", S, breakeven, T, r, sigma);
    // Realistisches Kursziel: +1 Standardabweichung (IV-skaliert über die Laufzeit).
    // Weit-OTM-Lottoscheine erreichen das Ziel nicht → negativer Ertrag → Score 0.
    const oneSigma = S * sigma * Math.sqrt(T);
    const targetPrice = S + oneSigma;
    const targetProfit = Math.max(0, targetPrice - K) * 100 - cost;
    const retPct = targetProfit / cost;
    const annRet = annualize(retPct, dte);
    const score = Math.max(0, annRet) * popBreakeven * 0.6;
    return {
      ticker, strategy: "lc", strategyLabel: "Long Call",
      setup: `Kaufe ${K}C @ ${premium.toFixed(2)} • BE ${breakeven.toFixed(2)}`,
      strike: K, premium: -cost, maxRisk: cost,
      dte, pop: popBreakeven, annRet, score, iv: sigma,
      expirationDate: call.expiration,
      underlying: S, premiumPerShare: premium,
    };
  }

  function pickExpiration(expirations, maxDte) {
    const now = Date.now() / 1000;
    const candidates = expirations.filter(e => {
      const dte = (e - now) / 86400;
      return dte >= 14 && dte <= maxDte;
    });
    if (!candidates.length) return null;
    return candidates.reduce((best, e) => {
      const dte = (e - now) / 86400;
      const distance = Math.abs(dte - Math.min(maxDte, 35));
      const bestDistance = Math.abs((best - now) / 86400 - Math.min(maxDte, 35));
      return distance < bestDistance ? e : best;
    }, candidates[0]);
  }

  async function processTicker(t, { strategies, maxDte, r }) {
    let cboe;
    try {
      cboe = await API.getCboeChain(t);
    } catch (firstErr) {
      await new Promise(res => setTimeout(res, 400));
      cboe = await API.getCboeChain(t); // ein Retry bei Proxy-Hickup
    }
    const exp = pickExpiration(cboe.expirations, maxDte);
    if (!exp) throw new Error("Keine Expiration im DTE-Range");
    const S = cboe.price;
    if (!S) throw new Error("Kein Underlying-Preis");
    const dte = dteFrom(exp);
    const chain = cboe.byExp.get(exp) || {};
    const calls = (chain.calls || []).filter(c => c.bid > 0 || c.ask > 0);
    const puts = (chain.puts || []).filter(p => p.bid > 0 || p.ask > 0);

    const collected = [];
    if (strategies.includes("csp")) {
      for (const p of puts.filter(p => p.strike < S && p.strike >= S * 0.85)) {
        const res = cashSecuredPut(t, S, p, dte, r); if (res) collected.push(res);
      }
    }
    if (strategies.includes("cc")) {
      for (const c of calls.filter(c => c.strike > S && c.strike <= S * 1.15)) {
        const res = coveredCall(t, S, c, dte, r); if (res) collected.push(res);
      }
    }
    if (strategies.includes("bps")) {
      const res = bullPutSpread(t, S, puts, dte, r); if (res) collected.push(res);
    }
    if (strategies.includes("lc")) {
      for (const c of calls.filter(c => c.strike >= S * 0.97 && c.strike <= S * 1.10)) {
        const res = longCall(t, S, c, dte, r); if (res) collected.push(res);
      }
    }
    return collected;
  }

  async function scan({ tickers, strategies, minPop, maxDte, onProgress, concurrency = 4 }) {
    const filtered = [];
    const allSetups = [];
    const errors = [];
    let ok = 0, done = 0;
    const r = CFG.RISK_FREE_RATE;
    const ctx = { strategies, maxDte, r };

    let next = 0;
    async function worker() {
      while (next < tickers.length) {
        const t = tickers[next++];
        try {
          const collected = await processTicker(t, ctx);
          allSetups.push(...collected);
          for (const res of collected) {
            if (res.strategy === "lc" || res.pop >= minPop) filtered.push(res);
          }
          ok++;
        } catch (e) {
          errors.push({ t, reason: e.message || String(e) });
          console.warn("Scan-Fehler", t, e.message);
        }
        done++;
        onProgress?.(done, tickers.length, t);
      }
    }
    // N Worker parallel → schneller, aber kontrollierte Proxy-Last
    await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));

    filtered.sort((a, b) => b.score - a.score);
    allSetups.sort((a, b) => b.score - a.score);
    return {
      results: filtered.slice(0, 50),
      fallback: allSetups.slice(0, 30),
      errors,
      ok,
      total: tickers.length,
    };
  }

  window.STRAT = { scan };
})();
