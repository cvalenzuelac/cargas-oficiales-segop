// Visual de carga por persona: columnas apiladas alrededor de una línea de cero, en
// eventos equivalentes (una sola escala):
//   ▲ por encima del cero: carga PENDIENTE   (Sara + Planner por etiqueta)
//   ▼ por debajo del cero: carga GESTIONADA en la ventana de trabajo (7 días)
// Cada categoría conserva su color arriba y abajo. Tooltip por columna (puntero y
// teclado); clic/Enter abre el detalle. La tabla de la página tiene los mismos números.

import { el, fmtNumber } from "./ui.js";

const SVG = "http://www.w3.org/2000/svg";
const fmt1 = (n) => fmtNumber(Math.round(n * 10) / 10);
const seriesVar = (slot) => `var(--series-${slot})`;

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Paso "limpio" (1, 2, 5 × 10^n) para ~targetTicks marcas en el rango total. */
export function niceStep(range, targetTicks = 6) {
  if (!(range > 0)) return 1;
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
}

/** Escala del eje con cero: arriba hasta `up`, abajo hasta `down` (múltiplos del paso). */
export function divergingScale(maxUp, maxDown) {
  const step = niceStep(maxUp + maxDown);
  return { step, up: Math.max(step, Math.ceil(maxUp / step) * step), down: Math.max(maxDown > 0 ? step : 0, Math.ceil(maxDown / step) * step) };
}

/** Rectángulo con las esquinas del extremo de dato redondeadas (arriba o abajo). */
function barPath(x, y, w, h, r, roundTop) {
  r = Math.min(r, h, w / 2);
  if (roundTop) {
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

function splitName(name) {
  const words = name.split(/\s+/);
  if (words.length <= 1) return [name, ""];
  // "Maria Cristina Borrero Arciniegas" -> "Maria Cristina" / "Borrero" (nombre / primer apellido)
  const first = words.length >= 4 ? words.slice(0, 2).join(" ") : words[0];
  const rest = words.length >= 4 ? words[2] : words[1];
  return [first, rest];
}

export class LoadChart {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.tooltip = el("div", { class: "lc-tooltip", role: "tooltip", hidden: true });
    this.root = el("figure", { class: "load-chart" });
    document.body.append(this.tooltip);
  }

  showTooltip(row, x, y) {
    const line = (value, label, slot, done) => {
      const key = el("span", { class: done ? "tt-key lc-done" : "tt-key" });
      key.style.setProperty("background", seriesVar(slot));
      return el("div", { class: `tt-row${value > 0 ? "" : " muted"}` }, key, el("strong", { text: fmt1(value) }), el("span", { text: label }));
    };
    const section = (title, total, pick, done) => [
      el("div", { class: "tt-section" }, el("span", { text: title }), el("strong", { text: fmt1(total) })),
      ...this.series.map((s) => line(pick(s), s.label, s.slot, done)),
    ];
    this.tooltip.replaceChildren(
      el("div", { class: "tt-title", text: row.name }),
      ...section("▲ Pendiente", row.load.pending, (s) => s.pending(row), false),
      ...section(`▼ Gestionado ${this.workDays} días`, row.load.done, (s) => s.done(row), true),
      el("div", { class: "tt-foot", text: `${fmtNumber(row.sara.flights)} vuelos de Sara · ${fmtNumber(row.planner.open)} tareas de Planner` }),
    );
    this.tooltip.hidden = false;
    const { width, height } = this.tooltip.getBoundingClientRect();
    const left = x + width + 24 > window.innerWidth ? x - width - 14 : x + 14;
    const top = Math.min(window.innerHeight - height - 8, Math.max(8, y - height / 2));
    this.tooltip.style.setProperty("left", `${Math.max(8, left)}px`);
    this.tooltip.style.setProperty("top", `${top}px`);
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }

  /** rows: personas ya ordenadas; series: model.series; workDays: ventana de trabajo. */
  render(rows, series, { workDays = 7 } = {}) {
    this.series = series;
    this.workDays = workDays;

    const legend = el("div", { class: "lc-legend" },
      series.map((s) => {
        const sw = el("span", { class: "lc-swatch" });
        sw.style.setProperty("background", seriesVar(s.slot));
        return el("span", { class: "lc-legend-item", title: s.detail }, sw, s.label);
      }),
      el("span", { class: "lc-legend-key" }, el("b", { text: "▲" }), " pendiente   ", el("b", { text: "▼" }), ` gestionado ${workDays} días`),
    );

    if (!rows.length) {
      this.root.replaceChildren(legend, el("p", { class: "muted lc-empty", text: "Sin personas para mostrar." }));
      return this.root;
    }

    const scale = divergingScale(Math.max(0, ...rows.map((r) => r.load.pending)), Math.max(0, ...rows.map((r) => r.load.done)));
    const colW = 72;
    const barW = 24;
    const axisW = 44;
    const top = 22;
    const plotH = 320;
    const nameH = 40;
    const width = axisW + rows.length * colW + 8;
    const unit = plotH / (scale.up + scale.down);
    const y0 = top + scale.up * unit;
    const height = top + plotH + 22 + nameH;

    const chart = svg("svg", {
      viewBox: `0 0 ${width} ${height}`, width, height, role: "img",
      "aria-label": "Carga por persona: pendiente arriba del cero y gestionada abajo",
      class: "lc-svg",
    });

    // marcas y líneas guía (hairline), etiquetas en valor absoluto
    for (let v = -scale.down; v <= scale.up + 1e-9; v += scale.step) {
      const y = y0 - v * unit;
      chart.append(svg("line", { x1: axisW, x2: width, y1: y, y2: y, class: v === 0 ? "lc-zero" : "lc-grid" }));
      chart.append(svg("text", { x: axisW - 8, y: y + 4, class: "lc-tick", "text-anchor": "end" }, document.createTextNode(fmtNumber(Math.abs(v)))));
    }
    chart.append(svg("text", { x: 4, y: top - 8, class: "lc-axis-label" }, document.createTextNode("▲ pendiente")));
    chart.append(svg("text", { x: 4, y: top + plotH + 16, class: "lc-axis-label" }, document.createTextNode(`▼ gestionado ${workDays} d`)));

    rows.forEach((row, i) => {
      const cx = axisW + i * colW + colW / 2;
      const x = cx - barW / 2;
      const g = svg("g", { class: "lc-col", tabindex: 0, role: "button",
        "aria-label": `${row.name}: ${fmt1(row.load.pending)} pendiente, ${fmt1(row.load.done)} gestionado en ${workDays} días` });
      // zona de interacción: toda la columna
      g.append(svg("rect", { x: cx - colW / 2, y: top - 18, width: colW, height: plotH + 40 + nameH, class: "lc-hit" }));

      const stack = (pick, upward) => {
        const parts = series.map((s) => ({ s, v: pick(s) })).filter((p) => p.v > 0);
        let offset = 0;
        parts.forEach((p, k) => {
          const h = p.v * unit;
          const gap = k < parts.length - 1 ? 2 : 0; // 2px de superficie entre segmentos
          const segH = Math.max(1, h - gap);
          const y = upward ? y0 - offset - h + gap : y0 + offset;
          const last = k === parts.length - 1;
          const shape = last
            ? svg("path", { d: barPath(x, y, barW, segH, 4, upward) })
            : svg("rect", { x, y, width: barW, height: segH });
          shape.setAttribute("fill", seriesVar(p.s.slot));
          if (!upward) shape.setAttribute("class", "lc-done"); // gestionado: tono pastel
          g.append(shape);
          offset += h;
        });
        return offset;
      };
      const up = stack((s) => s.pending(row), true);
      const down = stack((s) => s.done(row), false);

      g.append(svg("text", { x: cx, y: y0 - up - 6, class: "lc-val", "text-anchor": "middle" }, document.createTextNode(fmt1(row.load.pending))));
      if (row.load.done > 0) {
        g.append(svg("text", { x: cx, y: y0 + down + 14, class: "lc-val muted", "text-anchor": "middle" }, document.createTextNode(fmt1(row.load.done))));
      }
      const [first, last] = splitName(row.name);
      const ny = top + plotH + 34;
      g.append(svg("text", { x: cx, y: ny, class: "lc-name", "text-anchor": "middle" }, document.createTextNode(first)));
      g.append(svg("text", { x: cx, y: ny + 14, class: "lc-name", "text-anchor": "middle" }, document.createTextNode(last)));

      g.addEventListener("pointermove", (e) => this.showTooltip(row, e.clientX, e.clientY));
      g.addEventListener("pointerleave", () => this.hideTooltip());
      g.addEventListener("focus", () => {
        const r = g.getBoundingClientRect();
        this.showTooltip(row, r.right, r.top + r.height / 2);
      });
      g.addEventListener("blur", () => this.hideTooltip());
      g.addEventListener("click", () => {
        this.hideTooltip();
        this.onSelect(row.key);
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.hideTooltip();
          this.onSelect(row.key);
        } else if (e.key === "Escape") {
          this.hideTooltip();
        }
      });
      chart.append(g);
    });

    this.root.replaceChildren(legend, el("div", { class: "lc-scroll" }, chart));
    return this.root;
  }
}
