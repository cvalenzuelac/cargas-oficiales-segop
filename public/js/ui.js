// Utilidades de interfaz: creación de nodos, formatos y tabla ordenable.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = String(value);
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const NUMBER = new Intl.NumberFormat("es-CO");

export const fmtNumber = (n) => (n === null || n === undefined ? "—" : NUMBER.format(n));

/** "1 urgente" / "3 urgentes" (plural por defecto: singular + "s"). */
export const plural = (n, singular, pluralForm = `${singular}s`) => `${fmtNumber(n)} ${n === 1 ? singular : pluralForm}`;

export function fmtDate(iso, withTime = false) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  });
}

/** Barra horizontal: `value` respecto de `max`, con una marca opcional en `target`. */
export function bar(value, max, { target = null, tone = "" } = {}) {
  const track = el("span", { class: "bar-track" });
  const fill = el("span", { class: `bar-fill ${tone}`.trim() });
  fill.style.setProperty("width", `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`);
  track.append(fill);
  if (target !== null && max > 0) {
    const mark = el("span", { class: "bar-target", title: `Objetivo: ${fmtNumber(Math.round(target))}` });
    mark.style.setProperty("left", `${Math.min(100, (target / max) * 100)}%`);
    track.append(mark);
  }
  return track;
}

export const tag = (text, tone = "") => el("span", { class: `tag ${tone}`.trim(), text });

/**
 * Tabla ordenable por clic en el encabezado.
 * columns: [{ key, label, num?, sort?: (row) => valor, render?: (row) => Node|texto, title? }]
 */
export class SortableTable {
  constructor({ columns, sortKey, sortDir = 1, onRowClick = null, empty = "Sin datos", pageSize = 0, caption = null }) {
    Object.assign(this, { columns, sortKey, sortDir, onRowClick, empty, pageSize, caption });
    this.rows = [];
    this.limit = pageSize;
    this.root = el("div", { class: "table-wrap" });
  }

  setRows(rows) {
    this.rows = rows;
    this.limit = this.pageSize;
    this.render();
    return this.root;
  }

  sortedRows() {
    const col = this.columns.find((c) => c.key === this.sortKey);
    if (!col) return this.rows;
    const value = col.sort || ((row) => row[col.key]);
    return [...this.rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "es");
      return cmp * this.sortDir;
    });
  }

  render() {
    const head = el("tr", {}, this.columns.map((col) => {
      const active = col.key === this.sortKey;
      const label = el("button", {
        type: "button",
        class: "th-sort",
        title: col.title || null,
        onclick: () => {
          this.sortDir = active ? -this.sortDir : col.num ? -1 : 1;
          this.sortKey = col.key;
          this.render();
        },
      }, col.label, active ? (this.sortDir > 0 ? " ▲" : " ▼") : "");
      return el("th", {
        scope: "col",
        class: col.num ? "num" : null,
        "aria-sort": active ? (this.sortDir > 0 ? "ascending" : "descending") : null,
      }, label);
    }));

    const all = this.sortedRows();
    const shown = this.limit > 0 ? all.slice(0, this.limit) : all;
    const body = shown.length
      ? shown.map((row) => {
          const tr = el("tr", {}, this.columns.map((col) =>
            el("td", { class: col.num ? "num" : null }, col.render ? col.render(row) : row[col.key] ?? "—")
          ));
          if (this.onRowClick) {
            tr.classList.add("clickable");
            tr.tabIndex = 0;
            tr.addEventListener("click", () => this.onRowClick(row));
            tr.addEventListener("keydown", (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.onRowClick(row);
              }
            });
          }
          return tr;
        })
      : [el("tr", {}, el("td", { class: "empty", colspan: this.columns.length, text: this.empty }))];

    const table = el("table", {},
      this.caption ? el("caption", { class: "sr-only", text: this.caption }) : null,
      el("thead", {}, head),
      el("tbody", {}, body),
    );
    const more = all.length > shown.length
      ? el("button", {
          type: "button",
          class: "btn more",
          onclick: () => {
            this.limit += this.pageSize;
            this.render();
          },
        }, `Mostrar más (${fmtNumber(all.length - shown.length)} restantes)`)
      : null;
    this.root.replaceChildren(table, ...(more ? [more] : []));
  }
}
