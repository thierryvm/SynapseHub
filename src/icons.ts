/**
 * Inline SVG builders, all created via `document.createElementNS` so we never
 * rely on `innerHTML` (security hook compliance, see `.claude/hooks/`).
 *
 * The functions return fresh DOM nodes; callers append them where needed and
 * are free to set additional attributes (`width`, `height`, `class`, etc.)
 * after the fact.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(
  viewBox: string,
  attrs: Record<string, string> = {},
): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function svgPath(
  parent: SVGElement,
  d: string,
  attrs: Record<string, string> = {},
): void {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  parent.appendChild(p);
}

export function svgCircle(
  parent: SVGElement,
  cx: number,
  cy: number,
  r: number,
  attrs: Record<string, string> = {},
): void {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", String(cx));
  c.setAttribute("cy", String(cy));
  c.setAttribute("r", String(r));
  for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
  parent.appendChild(c);
}

export function svgLine(
  parent: SVGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  attrs: Record<string, string> = {},
): void {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v);
  parent.appendChild(l);
}

export function svgRect(
  parent: SVGElement,
  attrs: Record<string, string>,
): void {
  const r = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v);
  parent.appendChild(r);
}

// ─── Domain icons ───────────────────────────────────────────────────────────

export function buildBranchIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
  });
  svgCircle(s, 4, 3, 1.6);
  svgCircle(s, 4, 13, 1.6);
  svgCircle(s, 12, 6, 1.6);
  svgPath(s, "M4 4.6v6.8");
  svgPath(s, "M4 7.5c0-1.5 1-2.5 2.5-2.5h2.5");
  return s;
}

export function buildFocusIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
  });
  svgPath(s, "M2 5V3a1 1 0 0 1 1-1h2");
  svgPath(s, "M14 5V3a1 1 0 0 0-1-1h-2");
  svgPath(s, "M2 11v2a1 1 0 0 0 1 1h2");
  svgPath(s, "M14 11v2a1 1 0 0 1-1 1h-2");
  svgCircle(s, 8, 8, 2);
  return s;
}

export function buildCheckIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svgPath(s, "M3 8.5l3 3 7-7");
  return s;
}

export function buildCopyIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svgPath(s, "M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2");
  svgRect(s, { x: "5", y: "5", width: "9", height: "9", rx: "1.2" });
  return s;
}

export function buildAlertIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svgPath(s, "M8 2L1.5 13.5h13L8 2z");
  svgPath(s, "M8 6.5v3.5M8 12v.5");
  return s;
}

export function buildCloseIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
  });
  svgPath(s, "M3.5 3.5l9 9M12.5 3.5l-9 9");
  return s;
}

/** Single rounded square — the "maximize" affordance shown when the window
 * is in its normal (non-maximized) state. Click swaps to {@link buildRestoreIcon}. */
export function buildMaximizeIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linejoin": "round",
  });
  svgRect(s, { x: "3.5", y: "3.5", width: "9", height: "9", rx: "0.6" });
  return s;
}

/** Two overlapping squares — the "restore" affordance shown when the window
 * is currently maximized. Matches the Windows convention (back square peeking
 * out top-right, front square fully drawn bottom-left). */
export function buildRestoreIcon(): SVGSVGElement {
  const s = svg("0 0 16 16", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  // Back square — only the top edge and the right edge are visible (the
  // bottom-left corner is hidden behind the front square).
  svgPath(s, "M6 3.5h6.5v6.5");
  // Front square — fully drawn rounded rectangle.
  svgRect(s, { x: "3.5", y: "6", width: "6.5", height: "6.5", rx: "0.6" });
  return s;
}

export function buildBrandGlyph(): SVGSVGElement {
  const s = svg("0 0 32 32", { fill: "none", xmlns: SVG_NS });
  svgCircle(s, 16, 16, 3.2, { fill: "currentColor" });
  svgCircle(s, 16, 16, 6, {
    stroke: "currentColor",
    "stroke-width": "1.2",
    "stroke-opacity": "0.5",
  });
  svgLine(s, 16, 16, 5, 5, {
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
  });
  svgLine(s, 16, 16, 27, 5, {
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
  });
  svgLine(s, 16, 16, 5, 27, {
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
  });
  svgLine(s, 16, 16, 27, 27, {
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
  });
  svgCircle(s, 5, 5, 2, { fill: "currentColor" });
  svgCircle(s, 27, 5, 2, { fill: "currentColor" });
  svgCircle(s, 5, 27, 2, { fill: "currentColor" });
  svgCircle(s, 27, 27, 2, { fill: "currentColor" });
  return s;
}
