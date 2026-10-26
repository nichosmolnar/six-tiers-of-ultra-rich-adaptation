import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// ---- Tiers and formatting ----

const TIERS = [
  { id: 1, min: 1e7, max: 1e8, label: "$10M-$100M", buys: "Can buy luxury homes and cars, first class air travel", color: "#3fd0c9" },
  { id: 2, min: 1e8, max: 1e9, label: "$100M-$1B", buys: "Can buy jet charters, family offices", color: "#b57bff" },
  { id: 3, min: 1e9, max: 1e10, label: "$1B-$10B", buys: "Can buy private jets, trophy mansions", color: "#d6e04a" },
  { id: 4, min: 1e10, max: 1e11, label: "$10B-$100B", buys: "Can buy mega yachts, sports teams", color: "#3fb0ff" },
  { id: 5, min: 1e11, max: 1e12, label: "$100B-$1T", buys: "Can buy trophy media platforms", color: "#ff8a4c" },
  { id: 6, min: 1e12, max: Infinity, label: "$1T+", buys: "Can buy elections, space, AI", color: "#ff4d4d" },
];

// Axis runs a little past the tier edges so bubbles at $10M aren't clipped and the $1T+ band has room.
const DOMAIN_MIN = 6e6;
const DOMAIN_MAX = 4e12;

function formatMoney(v) {
  if (v >= 1e12) return `$${trim(v / 1e12)}T`;
  if (v >= 1e9) return `$${trim(v / 1e9)}B`;
  if (v >= 1e6) return `$${trim(v / 1e6)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

function trim(n) {
  if (n >= 100) return Math.round(n).toString();
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/\.?0+$/, "");
}

// ---- Tooltip ----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function formatAsOf(s) {
  if (!s) return "unknown";
  const d = new Date(s.length <= 7 ? `${s}-01T12:00` : `${s.slice(0, 10)}T12:00`);
  if (Number.isNaN(d.getTime()) || /^\d{4}$/.test(s)) return s;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", ...(s.length > 7 ? { day: "numeric" } : {}) });
}

function createTooltip(el) {
  function render(p) {
    const tier = TIERS[p.tier - 1];
    el.style.setProperty("--c", tier.color);
    const rows = [
      ["Tier", `<span class="tt-tier">Tier ${tier.id} · ${tier.label}</span>`],
      p.sourceOfWealth && ["Wealth from", esc(p.sourceOfWealth)],
      p.country && ["Country", esc(p.country)],
      p.selfMade != null && ["Origin", p.selfMade ? "Self-made" : "Inherited"],
      p.gdpPct != null && p.iso3 && ["Share of GDP", `${p.gdpPct < 0.01 ? "<0.01" : p.gdpPct.toFixed(2)}% of ${esc(p.iso3)} GDP`],
      p.rank != null && ["Forbes rank", `#${p.rank.toLocaleString()}`],
      ["As of", esc(formatAsOf(p.asOf))],
    ].filter(Boolean);

    const note = p.manual
      ? `Estimate, not a Forbes figure. Source: ${esc(p.source)}.`
      : p.override
        ? `Override of Forbes value (${formatMoney(p.forbesNetWorth)}). Source: ${esc(p.source)}.`
        : "";

    el.innerHTML = `
      <div class="tt-head">
        ${p.image ? `<img src="${esc(p.image)}" alt="" />` : `<div class="tt-initials">${esc(p.name.slice(0, 1))}</div>`}
        <div>
          <div class="tt-name">${esc(p.name)}</div>
          <div class="tt-worth">${formatMoney(p.netWorth)}</div>
        </div>
      </div>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${note ? `<div class="tt-note">${note}</div>` : ""}
    `;
  }

  function place(clientX, clientY) {
    const pad = 16;
    const { offsetWidth: w, offsetHeight: h } = el;
    let left = clientX + pad;
    let top = clientY + pad;
    if (left + w > window.innerWidth - 8) left = clientX - w - pad;
    if (top + h > window.innerHeight - 8) top = clientY - h - pad;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  let current = null;
  return {
    show(p, clientX, clientY) {
      if (current !== p) render(p);
      current = p;
      el.hidden = false;
      place(clientX, clientY);
    },
    showAt(p, element) {
      const b = element.getBoundingClientRect();
      if (current !== p) render(p);
      current = p;
      el.hidden = false;
      place(b.right, b.top + b.height / 2);
    },
    hide() {
      current = null;
      el.hidden = true;
    },
  };
}

// ---- Chart ----

// Below this radius a portrait is unreadable, so the bubble is drawn as a solid tier-colored dot.
const MIN_IMAGE_R = 9;

const initials = (name) =>
  name
    .replace(/&.*$/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

const displayName = (name) => name.replace(/\s*&\s*family$/i, "");

const tierColor = (person) => TIERS[person.tier - 1].color;

// Word-wraps an SVG text into tspans; hides it if it needs more than maxLines.
function wrapText(textSel, str, maxWidth, maxLines) {
  const x = textSel.attr("x");
  textSel.attr("display", null).text(null);
  const lines = [];
  let line = [];
  let tspan = textSel.append("tspan").attr("x", x);
  for (const word of str.split(/\s+/)) {
    line.push(word);
    tspan.text(line.join(" "));
    if (line.length > 1 && tspan.node().getComputedTextLength() > maxWidth) {
      line.pop();
      tspan.text(line.join(" "));
      lines.push(tspan);
      line = [word];
      tspan = textSel.append("tspan").attr("x", x).text(word);
    }
  }
  lines.push(tspan);
  lines.forEach((t, i) => t.attr("dy", i ? "1.3em" : 0));
  const fits = lines.length <= maxLines && lines.every((t) => t.node().getComputedTextLength() <= maxWidth);
  if (!fits) textSel.attr("display", "none");
}

/**
 * Horizontal beeswarm of people on a log net-worth axis.
 * Tier bands sit behind the bubbles and toggle their tier on click.
 * Callbacks: onHover(person|null, event), onSelect(person, element),
 * onLayout({ plotLeft }) where plotLeft is the Tier 1 band's left edge in container pixels.
 */
function createChart(container, people, { onHover, onSelect, onLayout } = {}) {
  const state = {
    sizeBy: "worth",
    activeTiers: new Set(TIERS.map((t) => t.id)),
  };
  let nodes = [];
  let width = 0;
  let height = 0;
  let compact = false; // narrow layout: bands show only the tier label; range and buys move to the legend
  let margin;
  let v; // value scale: net worth -> pixel along the value axis

  const svg = d3.select(container).append("svg").attr("role", "img");
  const defs = svg.append("defs");
  defs
    .append("clipPath")
    .attr("id", "bubble-clip")
    .attr("clipPathUnits", "objectBoundingBox")
    .append("circle")
    .attr("cx", 0.5)
    .attr("cy", 0.5)
    .attr("r", 0.5);
  const plotClip = defs.append("clipPath").attr("id", "plot-clip").append("rect");

  const gBands = svg.append("g").attr("class", "bands");
  const gAxis = svg.append("g").attr("class", "axis");
  const axisTitle = svg.append("text").attr("class", "axis-title").attr("text-anchor", "middle");
  const gPlot = svg.append("g").attr("clip-path", "url(#plot-clip)").attr("class", "plot");
  const gBubbles = gPlot.append("g").attr("class", "bubbles");
  const gLabels = gPlot.append("g").attr("class", "labels");

  const pos = (d) => [d.x, d.y];

  function radiusFn() {
    if (state.sizeBy === "worth") {
      // Area proportional to net worth.
      const maxR = Math.max(28, Math.min(72, width / 14));
      const s = d3.scaleSqrt().domain([0, d3.max(people, (p) => p.netWorth)]).range([0, maxR]);
      return (p) => Math.max(2.5, s(p.netWorth));
    }
    const base = Math.max(8, Math.min(19, width / 75));
    // Light log scaling so size hints at wealth without competing with the axis.
    return (p) => base * (0.8 + 0.07 * Math.log10(Math.max(p.netWorth, DOMAIN_MIN) / DOMAIN_MIN));
  }

  function layout() {
    width = container.clientWidth;
    const r = radiusFn();

    compact = width <= 640;
    margin = { top: compact ? 40 : 112, right: 16, bottom: 48, left: 16 };
    v = d3.scaleLog().domain([DOMAIN_MIN, DOMAIN_MAX]).range([margin.left, width - margin.right]).clamp(true);

    const prevById = new Map(nodes.map((n) => [n.id, n]));
    nodes = people.map((p) => {
      const tv = v(Math.max(p.netWorth, DOMAIN_MIN));
      const prev = prevById.get(p.id);
      const jitter = (Math.random() - 0.5) * 40;
      return { ...p, r: r(p), tv, x: prev?.x ?? tv, y: prev?.y ?? jitter };
    });

    const sim = d3
      .forceSimulation(nodes)
      .force("collide", d3.forceCollide((d) => d.r + 1.5).iterations(3))
      .force("x", d3.forceX((d) => d.tv).strength(1))
      .force("y", d3.forceY(0).strength(0.045))
      .stop();
    for (let i = 0; i < 320; i++) sim.tick();

    const labelPad = width > 640 ? 16 : 0;
    const minY = d3.min(nodes, (d) => d.y - d.r);
    const maxY = d3.max(nodes, (d) => d.y + d.r) + labelPad;
    const swarmH = Math.max(maxY - minY, 160);
    const offset = margin.top + 8 - minY;
    for (const n of nodes) n.y += offset;
    height = margin.top + swarmH + 16 + margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);
    plotClip
      .attr("x", margin.left - 30)
      .attr("y", 0)
      .attr("width", width - margin.left - margin.right + 60)
      .attr("height", height - margin.bottom + 10);
    svg.attr(
      "aria-label",
      `Beeswarm chart of ${people.length} people by net worth on a logarithmic scale, grouped into six tiers.`,
    );

    drawBubbles();
    positionAll();
    applyActive();
    onLayout?.({ plotLeft: Math.max(v(TIERS[0].min), margin.left), compact });
  }

  function drawBubbles() {
    const sel = gBubbles
      .selectAll("g.bubble")
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter
          .append("g")
          .attr("class", "bubble")
          .attr("tabindex", 0)
          .attr("role", "button")
          .attr("aria-label", (d) => `${d.name}, ${formatMoney(d.netWorth)}, tier ${d.tier}`);
        g.append("circle").attr("class", "bg");
        g.filter((d) => d.image)
          .append("image")
          .attr("href", (d) => d.image)
          .attr("preserveAspectRatio", "xMidYMin slice")
          .attr("clip-path", "url(#bubble-clip)");
        g.filter((d) => !d.image)
          .append("text")
          .attr("class", "initials")
          .text((d) => initials(d.name));
        g.append("circle").attr("class", "ring");
        g.append("circle").attr("class", "halo");
        return g;
      });

    const showFace = (d) => d.r >= MIN_IMAGE_R;
    sel.select("circle.bg")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => (d.image && showFace(d) ? "#2a2170" : tierColor(d)));
    sel.select("circle.ring")
      .attr("r", (d) => d.r)
      .attr("stroke", tierColor)
      .style("stroke-width", (d) => (d.r < 6 ? "1px" : null));
    sel.select("circle.halo").attr("r", (d) => d.r + 2.5);
    sel.select("image")
      .attr("display", (d) => (showFace(d) ? null : "none"))
      .attr("x", (d) => -d.r)
      .attr("y", (d) => -d.r)
      .attr("width", (d) => d.r * 2)
      .attr("height", (d) => d.r * 2);
    sel.select("text.initials")
      .attr("display", (d) => (showFace(d) ? null : "none"))
      .attr("font-size", (d) => Math.max(8, Math.min(d.r * 0.75, 22)));

    sel
      .on("pointerenter pointermove", function (event, d) {
        if (event.pointerType === "mouse") onHover?.(d, event);
      })
      .on("pointerleave", function (event) {
        if (event.pointerType === "mouse") onHover?.(null, event);
      })
      .on("click", function (event, d) {
        event.stopPropagation();
        onSelect?.(d, this);
      })
      .on("focus", function (event, d) {
        onSelect?.(d, this);
      })
      .on("blur", () => onHover?.(null, null))
      .on("keydown", function (event, d) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(d, this);
        }
      });

    gLabels
      .selectAll("text.name-label")
      .data(width > 640 ? nodes.filter((d) => d.label) : [], (d) => d.id)
      .join("text")
      .attr("class", "name-label")
      .text((d) => displayName(d.name));
  }

  function toggleTier(id) {
    if (state.activeTiers.has(id)) state.activeTiers.delete(id);
    else state.activeTiers.add(id);
    applyActive();
  }

  function drawBands(zv) {
    const bands = gBands
      .selectAll("g.band")
      .data(TIERS, (t) => t.id)
      .join((enter) => {
        const g = enter
          .append("g")
          .attr("class", "band")
          .attr("tabindex", 0)
          .attr("role", "button")
          .on("click", (event, t) => {
            event.stopPropagation();
            toggleTier(t.id);
          })
          .on("keydown", (event, t) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleTier(t.id);
            }
          });
        g.append("rect").attr("class", "band-bg");
        g.append("text").attr("class", "band-label");
        g.append("text").attr("class", "band-range");
        g.append("text").attr("class", "band-buys");
        g.append("text").attr("class", "frontier-note");
        return g;
      });

    bands.each(function (t) {
      const g = d3.select(this);
      const empty = !people.some((p) => p.tier === t.id);
      const a = zv(t.min);
      const b = zv(Math.min(t.max, DOMAIN_MAX));
      const x0 = Math.max(Math.min(a, b), margin.left);
      const x1 = Math.min(Math.max(a, b), width - margin.right);
      const y0 = compact ? 26 : 46;
      const y1 = height - margin.bottom;
      const visible = x1 - x0 > 2;
      g.attr("display", visible ? null : "none");
      if (!visible) return;

      g.attr("aria-label", `Tier ${t.id}, ${t.label}. Click to ${state.activeTiers.has(t.id) ? "hide" : "show"}.`);
      g.select("rect.band-bg")
        .attr("x", x0)
        .attr("y", y0)
        .attr("width", x1 - x0)
        .attr("height", y1 - y0)
        .attr("rx", 12)
        .attr("fill", t.color)
        .attr("stroke", t.color)
        .attr("stroke-dasharray", empty ? "6 5" : null)
        .classed("empty", empty);

      const label = g.select("text.band-label").attr("fill", t.color);
      const range = g.select("text.band-range").attr("fill", t.color);
      const buys = g.select("text.band-buys");
      const note = g.select("text.frontier-note");

      const cx = (x0 + x1) / 2;
      const bw = x1 - x0;
      label.attr("x", cx).attr("y", 16).attr("text-anchor", "middle").text(compact || bw < 110 ? `T${t.id}` : `Tier ${t.id}`);
      if (compact) {
        range.attr("display", "none");
        buys.attr("display", "none");
      } else {
        range.attr("x", cx).attr("y", 34).attr("text-anchor", "middle").attr("display", null).style("font-size", null).text(t.label);
        const rangeW = range.node().getComputedTextLength();
        if (rangeW > bw - 4) {
          const size = (13 * (bw - 4)) / rangeW;
          if (size < 8) range.attr("display", "none");
          else range.style("font-size", `${size}px`);
        }
        wrapText(buys.attr("x", cx).attr("y", y0 + 18).attr("text-anchor", "middle"), t.buys, bw - 16, 3);
      }

      const showNote = empty && t.id === 6 && bw > 84;
      const nx = cx;
      const ny = margin.top + 24;
      note
        .attr("display", showNote ? null : "none")
        .attr("text-anchor", "middle")
        .attr("x", nx)
        .attr("y", ny)
        .selectAll("tspan")
        .data(["Elon Musk is", "occasionally", "in this tier"])
        .join("tspan")
        .attr("x", nx)
        .attr("dy", (_, i) => (i ? "1.3em" : 0))
        .text((s) => s);
    });
  }

  function drawAxis(zv) {
    const [d0, d1] = zv.domain();
    const span = Math.log10(d1) - Math.log10(d0);
    const length = width - margin.left - margin.right;
    const pxPerDecade = length / span;
    const mantissas = pxPerDecade > 260 ? [1, 2, 3, 5] : pxPerDecade > 140 ? [1, 3] : [1];
    const ticks = zv.ticks().filter((val) => {
      const m = val / 10 ** Math.floor(Math.log10(val) + 1e-9);
      return mantissas.some((k) => Math.abs(m - k) < 1e-6);
    });
    gAxis
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(zv).tickValues(ticks).tickFormat(formatMoney).tickSizeOuter(0));
    gAxis.select(".domain").attr("d", `M${zv(TIERS[0].min)},0H${zv.range()[1]}`);
    axisTitle.attr("x", width / 2).attr("y", height - 8);
    axisTitle.text("Net worth (log scale)");
  }

  function positionAll() {
    drawBands(v);
    drawAxis(v);
    gBubbles.selectAll("g.bubble").attr("transform", (d) => `translate(${pos(d)})`);
    placeLabels();
  }

  // Greedy label placement: richest first, skip any label whose box overlaps one already placed.
  function placeLabels() {
    const placed = [];
    const shown = new Set();
    const labels = gLabels
      .selectAll("text.name-label")
      .attr("x", (d) => pos(d)[0])
      .attr("y", (d) => pos(d)[1] + d.r + 12)
      .attr("display", null);
    const sorted = labels.nodes().sort((a, b) => d3.select(b).datum().netWorth - d3.select(a).datum().netWorth);
    for (const el of sorted) {
      const d = d3.select(el).datum();
      const [px, py] = pos(d);
      const w = el.getComputedTextLength() + 6;
      const box = { x0: px - w / 2, x1: px + w / 2, y0: py + d.r + 1, y1: py + d.r + 15 };
      const clash = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (clash) el.setAttribute("display", "none");
      else {
        el.removeAttribute("display");
        placed.push(box);
        shown.add(d.id);
      }
    }
    gBubbles.selectAll("g.bubble").classed("labeled", (d) => shown.has(d.id));
  }

  function applyActive() {
    const off = (d) => !state.activeTiers.has(d.tier);
    gBubbles.selectAll("g.bubble").classed("off", off).attr("tabindex", (d) => (off(d) ? -1 : 0));
    gLabels.selectAll("text.name-label").classed("off", off);
    gBands.selectAll("g.band").classed("off", (t) => !state.activeTiers.has(t.id)).attr("aria-pressed", (t) => String(state.activeTiers.has(t.id)));
  }

  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - width) < 2) return;
    clearTimeout(ro.timer);
    ro.timer = setTimeout(() => layout(), 120);
  });
  ro.observe(container);
  layout();

  return {
    setSizeBy(sizeBy) {
      state.sizeBy = sizeBy;
      layout();
    },
  };
}

// ---- App ----

const $ = (sel) => document.querySelector(sel);

async function init() {
  const res = await fetch("data/people.json");
  if (!res.ok) throw new Error(`Could not load data (${res.status}). Serve this folder over http (e.g. python3 -m http.server).`);
  const { people, forbesAsOf } = await res.json();

  if (forbesAsOf) {
    const d = new Date(forbesAsOf.replace(" UTC", "Z").replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) $("#as-of").textContent = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  const tooltip = createTooltip($("#tooltip"));
  let pinned = null;
  const unpin = () => {
    pinned = null;
    tooltip.hide();
  };

  // Lets the title line up with the left edge of the Tier 1 band.
  let plotLeft = 0;
  const syncPlotLeft = () => {
    const left = $("#chart").getBoundingClientRect().left + window.scrollX + plotLeft;
    document.documentElement.style.setProperty("--plot-left", `${Math.round(left)}px`);
    document.documentElement.style.setProperty("--plot-inset", `${Math.round(plotLeft)}px`);
  };
  window.addEventListener("resize", syncPlotLeft);

  $("#legend").innerHTML = TIERS.map(
    (t) => `
      <li style="--c: ${t.color}">
        <span class="lg-tier">T${t.id}</span>
        <span class="lg-range">${t.label}</span>
        <span class="lg-buys">${t.buys}</span>
      </li>`,
  ).join("");

  const chart = createChart($("#chart"), people, {
    onLayout(info) {
      plotLeft = info.plotLeft;
      syncPlotLeft();
      $("#legend").hidden = !info.compact;
    },
    onHover(p, event) {
      if (pinned) return;
      if (p) tooltip.show(p, event.clientX, event.clientY);
      else tooltip.hide();
    },
    onSelect(p, el) {
      pinned = pinned === p ? null : p;
      if (pinned) tooltip.showAt(p, el);
      else tooltip.hide();
    },
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".bubble")) unpin();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") unpin();
  });
  window.addEventListener("scroll", () => !pinned && tooltip.hide(), { passive: true });

  // Segmented toggles: data-control on the group, data-value on each button.
  document.querySelectorAll(".toggle[data-control]").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn || btn.classList.contains("active")) return;
      group.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      unpin();
      chart.setSizeBy(btn.dataset.value);
    });
  });
}

init().catch((err) => {
  console.error(err);
  $("#chart").innerHTML = `<p class="hint">${err.message}</p>`;
});
