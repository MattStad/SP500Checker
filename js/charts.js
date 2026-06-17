(() => {
  let chart;

  function render(canvasId, points, symbol, opts = {}, pre = {}) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    const labels = points.map(p => p.t);
    const closes = points.map(p => p.c);
    const volumes = points.map(p => p.v || 0);
    const up = closes[closes.length - 1] >= closes[0];
    const lineColor = up ? "#22c55e" : "#ef4444";
    const fillGrad = ctx.createLinearGradient(0, 0, 0, 320);
    fillGrad.addColorStop(0, up ? "rgba(34,197,94,0.30)" : "rgba(239,68,68,0.30)");
    fillGrad.addColorStop(1, "rgba(0,0,0,0)");

    const datasets = [
      {
        type: "line",
        label: symbol,
        data: closes,
        borderColor: lineColor,
        backgroundColor: fillGrad,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.18,
        yAxisID: "y",
        order: 5,
      },
      {
        type: "bar",
        label: "Volumen",
        data: volumes,
        backgroundColor: "rgba(96,165,250,0.20)",
        borderWidth: 0,
        yAxisID: "yv",
        order: 10,
      },
    ];

    if (opts.sma20 && pre.sma20) {
      datasets.push({
        type: "line", label: "SMA 20", data: pre.sma20,
        borderColor: "#f59e0b", borderWidth: 1.4, pointRadius: 0,
        spanGaps: false, fill: false, tension: 0.1, yAxisID: "y", order: 3,
      });
    }
    if (opts.sma50 && pre.sma50) {
      datasets.push({
        type: "line", label: "SMA 50", data: pre.sma50,
        borderColor: "#a855f7", borderWidth: 1.4, pointRadius: 0,
        borderDash: [4, 3], spanGaps: false, fill: false, tension: 0.1, yAxisID: "y", order: 3,
      });
    }
    if (opts.bollinger && pre.bbUpper && pre.bbLower) {
      datasets.push({
        type: "line", label: "BB Upper", data: pre.bbUpper,
        borderColor: "rgba(94,234,212,0.55)", borderWidth: 1, pointRadius: 0,
        borderDash: [3, 3], spanGaps: false, fill: false, yAxisID: "y", order: 4,
      });
      datasets.push({
        type: "line", label: "BB Lower", data: pre.bbLower,
        borderColor: "rgba(94,234,212,0.55)", borderWidth: 1, pointRadius: 0,
        borderDash: [3, 3], spanGaps: false, fill: "-1", backgroundColor: "rgba(94,234,212,0.06)",
        yAxisID: "y", order: 4,
      });
    }

    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: "#8a98b3", boxWidth: 10, boxHeight: 10, font: { size: 10 }, filter: (it) => it.text !== "Volumen" && it.text !== "BB Lower" },
            position: "top",
            align: "end",
          },
          tooltip: {
            backgroundColor: "#131b2a",
            borderColor: "#243049",
            borderWidth: 1,
            titleColor: "#e5ecf6",
            bodyColor: "#e5ecf6",
            callbacks: {
              label: (c) => {
                if (c.dataset.type === "bar") return `Vol: ${c.parsed.y?.toLocaleString("de-DE")}`;
                if (c.parsed.y == null) return null;
                return `${c.dataset.label}: $${c.parsed.y.toFixed(2)}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "time",
            time: { tooltipFormat: "PP" },
            ticks: { color: "#8a98b3", maxRotation: 0 },
            grid: { color: "rgba(36,48,73,0.4)" },
          },
          y: {
            position: "right",
            ticks: { color: "#8a98b3", callback: (v) => `$${v}` },
            grid: { color: "rgba(36,48,73,0.4)" },
          },
          yv: {
            position: "left",
            display: false,
            max: Math.max(...volumes) * 4,
          },
        },
      },
    });
  }

  window.CHARTS = { render };
})();
