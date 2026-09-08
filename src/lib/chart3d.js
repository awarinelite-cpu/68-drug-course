// True pseudo-3D chart styling for Chart.js (which has no native 3D chart
// type). Two techniques, one per chart shape:
//
// BARS — drawn as an actual extruded box: Chart.js already draws the front
// rectangle (using the gradient from frontFaceGradient() as its
// backgroundColor), and bar3dPlugin adds a lighter top cap and a darker
// side cap as extra polygons offset by (DEPTH_DX, DEPTH_DY), so each bar
// reads as a solid 3D block rather than a flat rectangle.
//
// PIES — drawn as a short cylinder: Chart.js draws the actual pie/arc
// (the "lid") using the gradient from pieFrontGradient(); pieDepthPlugin
// draws a ribbon-shaped "wall" per slice from the outer arc down to the
// same arc shifted down by DEPTH_PX, in a darker shade, *before* the lid
// is drawn on top. Only the wall's lower half ends up visible below the
// lid's own curve — exactly the visible "rim" a real extruded disc would
// cast — which is the standard trick for a canvas 3D pie chart.
//
// Both plugins expect the raw hex colors to be attached to the dataset
// (as `_solidColors`, one hex per data point) alongside whatever
// gradient function is used for the visible fill, since a canvas
// gradient object can't be inspected or reused to derive a shade.

export function shadeHex(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(((n >> 16) & 0xff) + Math.round(255 * percent));
  const g = clamp(((n >> 8) & 0xff) + Math.round(255 * percent));
  const b = clamp((n & 0xff) + Math.round(255 * percent));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// Glossy front-face fill for a bar: a left-to-right sweep (light near the
// left edge, darkening toward the right) — the highlight streak that
// reads as a curved/glossy surface in most "3D chart" renders.
export function barFrontGradient(ctx, chartArea, hex) {
  if (!chartArea) return hex;
  const g = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
  g.addColorStop(0, shadeHex(hex, 0.35));
  g.addColorStop(0.45, hex);
  g.addColorStop(1, shadeHex(hex, -0.15));
  return g;
}

// Glossy front-face fill for a pie slice: a small radial highlight offset
// toward the upper-left of the whole pie, same idea as barFrontGradient
// but radial since a slice has no single "left edge".
export function pieFrontGradient(ctx, chartArea, hex) {
  if (!chartArea) return hex;
  const cx = (chartArea.left + chartArea.right) / 2;
  const cy = (chartArea.top + chartArea.bottom) / 2;
  const r = Math.min(chartArea.right - chartArea.left, chartArea.bottom - chartArea.top) / 2;
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.05, cx, cy, r);
  g.addColorStop(0, shadeHex(hex, 0.3));
  g.addColorStop(1, shadeHex(hex, -0.12));
  return g;
}

const DEPTH_DX = 10;
const DEPTH_DY = -7;

export const bar3dPlugin = {
  id: 'bar3d',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'bar') return;
    const ctx = chart.ctx;
    const horizontal = chart.options.indexAxis === 'y';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;
      const colors = dataset._solidColors;
      if (!colors) return;
      meta.data.forEach((bar, i) => {
        const hex = Array.isArray(colors) ? colors[i] : colors;
        if (!hex || !bar) return;
        const props = bar.getProps(['x', 'y', 'base', 'width', 'height'], true);
        const topColor = shadeHex(hex, 0.24);
        const sideColor = shadeHex(hex, -0.3);
        ctx.save();
        if (!horizontal) {
          const left = props.x - props.width / 2;
          const right = props.x + props.width / 2;
          const top = Math.min(props.y, props.base);
          const bottom = Math.max(props.y, props.base);
          // Top cap
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(right, top);
          ctx.lineTo(right + DEPTH_DX, top + DEPTH_DY);
          ctx.lineTo(left + DEPTH_DX, top + DEPTH_DY);
          ctx.closePath();
          ctx.fillStyle = topColor;
          ctx.fill();
          // Right side cap
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right, bottom);
          ctx.lineTo(right + DEPTH_DX, bottom + DEPTH_DY);
          ctx.lineTo(right + DEPTH_DX, top + DEPTH_DY);
          ctx.closePath();
          ctx.fillStyle = sideColor;
          ctx.fill();
        } else {
          const top = props.y - props.height / 2;
          const bottom = props.y + props.height / 2;
          const left = Math.min(props.base, props.x);
          const right = Math.max(props.base, props.x);
          // Top cap (the long edge)
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(right, top);
          ctx.lineTo(right + DEPTH_DX, top + DEPTH_DY);
          ctx.lineTo(left + DEPTH_DX, top + DEPTH_DY);
          ctx.closePath();
          ctx.fillStyle = topColor;
          ctx.fill();
          // End cap (the right/far edge)
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right, bottom);
          ctx.lineTo(right + DEPTH_DX, bottom + DEPTH_DY);
          ctx.lineTo(right + DEPTH_DX, top + DEPTH_DY);
          ctx.closePath();
          ctx.fillStyle = sideColor;
          ctx.fill();
        }
        ctx.restore();
      });
    });
  }
};

const PIE_DEPTH = 16;
const PIE_BAND_STEPS = 28;

export const pieDepthPlugin = {
  id: 'pieDepth3d',
  beforeDatasetsDraw(chart) {
    if (chart.config.type !== 'pie' && chart.config.type !== 'doughnut') return;
    const ctx = chart.ctx;
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;
      const colors = dataset._solidColors;
      if (!colors) return;
      const offset = dataset.offset || 0;
      meta.data.forEach((arc, i) => {
        const hex = colors[i];
        if (!hex || !arc) return;
        const props = arc.getProps(['x', 'y', 'startAngle', 'endAngle', 'outerRadius'], true);
        const { startAngle, endAngle, outerRadius } = props;
        // Chart.js explodes a slice by translating the canvas along the
        // slice's own mid-angle during its own draw() — by exactly
        // (options.offset / 4) — rather than moving the arc's stored x/y.
        // Replicate that same translation here so the wall lines up with
        // the lid exactly.
        const half = offset / 4;
        const mid = (startAngle + endAngle) / 2;
        const cx = props.x + Math.cos(mid) * half;
        const cy = props.y + Math.sin(mid) * half;

        ctx.beginPath();
        for (let s = 0; s <= PIE_BAND_STEPS; s++) {
          const a = startAngle + (endAngle - startAngle) * (s / PIE_BAND_STEPS);
          const px = cx + Math.cos(a) * outerRadius;
          const py = cy + Math.sin(a) * outerRadius + PIE_DEPTH;
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let s = PIE_BAND_STEPS; s >= 0; s--) {
          const a = startAngle + (endAngle - startAngle) * (s / PIE_BAND_STEPS);
          const px = cx + Math.cos(a) * outerRadius;
          const py = cy + Math.sin(a) * outerRadius;
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = shadeHex(hex, -0.32);
        ctx.fill();
      });
    });
  }
};

// Soft drop shadow under whatever's drawn during the dataset pass, so bars
// and pies read as sitting slightly above the card instead of printed flat
// on it. Cleared right after so it never touches gridlines/axis text.
export const dropShadowPlugin = {
  id: 'dropShadow3d',
  beforeDatasetsDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
  },
  afterDatasetsDraw(chart) {
    chart.ctx.restore();
  }
};
