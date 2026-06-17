(() => {
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0 || values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      sum += values[i] - values[i - period];
      out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function stddev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let mean = 0;
      for (let j = i - period + 1; j <= i; j++) mean += values[j];
      mean /= period;
      let v = 0;
      for (let j = i - period + 1; j <= i; j++) v += (values[j] - mean) ** 2;
      out[i] = Math.sqrt(v / period);
    }
    return out;
  }

  function bollinger(values, period = 20, mult = 2) {
    const mid = sma(values, period);
    const sd = stddev(values, period);
    const upper = mid.map((m, i) => m == null ? null : m + mult * sd[i]);
    const lower = mid.map((m, i) => m == null ? null : m - mult * sd[i]);
    return { upper, mid, lower };
  }

  function rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gainSum += diff; else lossSum -= diff;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function macd(values, fast = 12, slow = 26, signal = 9) {
    const fastE = ema(values, fast);
    const slowE = ema(values, slow);
    const line = fastE.map((f, i) => (f == null || slowE[i] == null) ? null : f - slowE[i]);
    const cleanLine = line.filter(v => v != null);
    const sig = ema(cleanLine, signal);
    const signalAligned = new Array(values.length).fill(null);
    const offset = line.findIndex(v => v != null);
    if (offset >= 0) {
      for (let i = 0; i < sig.length; i++) {
        if (sig[i] != null) signalAligned[offset + i] = sig[i];
      }
    }
    const hist = line.map((l, i) => (l == null || signalAligned[i] == null) ? null : l - signalAligned[i]);
    return { line, signal: signalAligned, hist };
  }

  window.IND = { sma, ema, bollinger, rsi, macd, stddev };
})();
