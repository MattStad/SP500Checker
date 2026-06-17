(() => {
  function erf(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  function d1(S, K, T, r, sigma) {
    return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  }
  function d2(S, K, T, r, sigma) { return d1(S, K, T, r, sigma) - sigma * Math.sqrt(T); }

  function price(type, S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0) {
      const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
      return intrinsic;
    }
    const D1 = d1(S, K, T, r, sigma), D2 = d2(S, K, T, r, sigma);
    if (type === "call") return S * N(D1) - K * Math.exp(-r * T) * N(D2);
    return K * Math.exp(-r * T) * N(-D2) - S * N(-D1);
  }

  function greeks(type, S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    const D1 = d1(S, K, T, r, sigma), D2 = d2(S, K, T, r, sigma);
    const delta = type === "call" ? N(D1) : N(D1) - 1;
    const gamma = npdf(D1) / (S * sigma * Math.sqrt(T));
    const vega = S * npdf(D1) * Math.sqrt(T) / 100;
    const theta = (
      -(S * npdf(D1) * sigma) / (2 * Math.sqrt(T))
      - r * K * Math.exp(-r * T) * (type === "call" ? N(D2) : -N(-D2))
    ) / 365;
    return { delta, gamma, theta, vega };
  }

  function probITM(type, S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0) {
      if (type === "call") return S > K ? 1 : 0;
      return S < K ? 1 : 0;
    }
    const D2 = d2(S, K, T, r, sigma);
    return type === "call" ? N(D2) : N(-D2);
  }

  window.BS = { price, greeks, probITM, N };
})();
