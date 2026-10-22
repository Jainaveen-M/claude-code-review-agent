// Small SVG/HTML bar charts. Mark specs: bars <= 24px with a 4px rounded data-end and a
// square baseline, 2px surface gaps between stacked segments, solid hairline gridlines,
// text in text colours, a hover/focus tooltip, and a data table under every chart.
import { fill, h, s } from './dom.js';

const HEIGHT = 220;
const MARGIN = { top: 10, right: 8, bottom: 26, left: 30 };
const GAP = 2;
const RADIUS = 4;

function niceScale(max) {
  if (max <= 0) return { max: 4, step: 1 };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= rough);
  const stepInt = Math.max(1, Math.round(step));
  return { max: Math.ceil(max / stepInt) * stepInt, step: stepInt };
}

/** Column path with rounded top corners when `round`, square at the bottom. */
function columnPath(x, y, w, hgt, round) {
  const r = round ? Math.min(RADIUS, w / 2, hgt) : 0;
  return `M${x},${y + hgt}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + hgt}Z`;
}

function tooltipFor(wrap) {
  const tip = h('div', { class: 'viz-tooltip', hidden: true, role: 'presentation' });
  wrap.append(tip);
  return {
    show(x, y, title, rows) {
      fill(tip, 
        h('div', { class: 'tt-title' }, title),
        rows.map((row) => h('div', { class: 'tt-row' },
          row.color ? h('span', { class: 'key', style: { background: row.color } }) : null,
          h('strong', {}, String(row.value)),
          h('span', {}, row.label))));
      tip.hidden = false;
      const max = wrap.clientWidth;
      tip.style.left = `${Math.min(Math.max(x, 70), max - 70)}px`;
      tip.style.top = `${y}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function dataTable(head, rows) {
  return h('details', { class: 'data-table' },
    h('summary', {}, 'Show data'),
    h('table', {},
      h('thead', {}, h('tr', {}, head.map((cell, i) => h('th', { class: i ? 'num' : '' }, cell)))),
      h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell, i) => h('td', { class: i ? 'num' : '' }, cell)))))));
}

/**
 * Stacked columns over time. buckets: [{ label, title, values: { key: n } }],
 * series: [{ key, label, color }] in stacking order (bottom first).
 * onSelect(key) fires when a segment or legend entry is clicked; `selected` dims the others.
 */
export function stackedColumns({ buckets, series, onSelect, selected, unit = 'reviews' }) {
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = tooltipFor(wrap);
  const legend = h('div', { class: 'legend' }, series.map((sr) => {
    const total = buckets.reduce((n, b) => n + (b.values[sr.key] ?? 0), 0);
    return h('button', { type: 'button', 'aria-pressed': selected === sr.key ? 'true' : 'false', onclick: () => onSelect?.(sr.key) },
      h('span', { class: 'swatch', style: { background: sr.color } }), sr.label, h('span', { class: 'hint' }, String(total)));
  }));

  function draw() {
    const width = Math.max(wrap.clientWidth || 600, 280);
    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const totals = buckets.map((b) => series.reduce((n, sr) => n + (b.values[sr.key] ?? 0), 0));
    const { max, step } = niceScale(Math.max(...totals, 0));
    const y = (v) => MARGIN.top + plotH - (v / max) * plotH;
    const band = plotW / Math.max(buckets.length, 1);
    const barW = Math.min(24, Math.max(4, band * 0.62));
    const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 64))));

    const grid = [];
    for (let v = 0; v <= max; v += step) {
      grid.push(s('line', { class: v === 0 ? 'viz-base' : 'viz-grid', x1: MARGIN.left, x2: width - MARGIN.right, y1: Math.round(y(v)) + 0.5, y2: Math.round(y(v)) + 0.5 }));
      grid.push(s('text', { class: 'viz-axis', x: MARGIN.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }

    const marks = [];
    buckets.forEach((b, i) => {
      const cx = MARGIN.left + band * i + band / 2;
      const x = cx - barW / 2;
      const showTip = () => tip.show(cx, y(totals[i]) - 4, b.title ?? b.label, [
        ...series.slice().reverse().map((sr) => ({ value: b.values[sr.key] ?? 0, label: sr.label, color: sr.color })),
        { value: totals[i], label: `total ${unit}` },
      ]);
      // Whole-band hover target, bigger than the mark.
      marks.push(s('rect', { x: MARGIN.left + band * i, y: MARGIN.top, width: band, height: plotH, fill: 'transparent', onpointerenter: showTip, onpointerleave: tip.hide }));
      let base = 0;
      const present = series.filter((sr) => (b.values[sr.key] ?? 0) > 0);
      present.forEach((sr, j) => {
        const value = b.values[sr.key];
        const top = j === present.length - 1;
        const y0 = y(base);
        const y1 = y(base + value);
        const hgt = Math.max(1, y0 - y1 - (j > 0 ? GAP : 0));
        marks.push(s('path', {
          class: `viz-mark${selected && selected !== sr.key ? ' dim' : ''}`,
          d: columnPath(x, y1, barW, hgt, top),
          fill: sr.color,
          tabindex: 0,
          role: 'button',
          'aria-label': `${b.title ?? b.label}: ${value} ${sr.label}`,
          onpointerenter: showTip,
          onpointerleave: tip.hide,
          onfocus: showTip,
          onblur: tip.hide,
          onclick: () => onSelect?.(sr.key),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(sr.key); } },
        }));
        base += value;
      });
      if (i % labelEvery === 0) {
        marks.push(s('text', { class: 'viz-axis', x: cx, y: HEIGHT - 8, 'text-anchor': 'middle' }, b.label));
      }
    });

    const svg = s('svg', { viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, role: 'img', 'aria-label': `Reviews over time by verdict` }, grid, marks);
    wrap.querySelector('svg')?.remove();
    wrap.prepend(svg);
  }

  const observer = new ResizeObserver(() => draw());
  observer.observe(wrap);
  queueMicrotask(draw);

  return h('div', { class: 'stack' },
    legend,
    wrap,
    dataTable(['Period', ...series.map((sr) => sr.label)], buckets.map((b) => [b.title ?? b.label, ...series.map((sr) => b.values[sr.key] ?? 0)])));
}

/**
 * Horizontal bars, one colour. rows: [{ key, label (text or node), value, title }].
 * Values sit at the bar tip; onSelect(key) on click.
 */
export function horizontalBars({ rows, color, onSelect, selected, unit, valueHead = 'Value' }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const list = h('div', { class: 'hbars' }, rows.map((row) => {
    const pct = (row.value / max) * 100;
    return h('button', {
      type: 'button',
      class: `hbar${selected && selected !== row.key ? ' dim' : ''}`,
      'aria-pressed': selected === row.key ? 'true' : 'false',
      'aria-label': `${row.title ?? row.key}: ${row.value} ${unit}`,
      title: `${row.title ?? row.key}: ${row.value} ${unit}`,
      disabled: !onSelect || row.value === 0,
      onclick: () => onSelect?.(row.key),
    },
    h('span', { class: 'hbar-label' }, row.label),
    h('span', { class: 'hbar-track' },
      row.value > 0 ? h('span', { class: 'hbar-fill', style: { width: `calc((100% - 40px) * ${Math.max(pct, 1.5) / 100})`, background: color } }) : null,
      h('span', { class: 'hbar-value' }, String(row.value))));
  }));
  return h('div', { class: 'stack' },
    list,
    dataTable(['', valueHead], rows.map((r) => [r.title ?? r.key, r.value])));
}
