export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_DRAG = 8;

/**
 * Converts a drag in CSS pixels to a crop rect in image pixels, clamped to the image.
 * `scale` is image.naturalWidth / window.innerWidth, which absorbs the monitor's DPI.
 * Returns null for a drag under MIN_DRAG CSS px on either side.
 */
export function cropRect(a: Point, b: Point, scale: number, imgW: number, imgH: number): Rect | null {
  if (Math.abs(a.x - b.x) < MIN_DRAG || Math.abs(a.y - b.y) < MIN_DRAG) return null;
  const x0 = Math.max(0, Math.round(Math.min(a.x, b.x) * scale));
  const y0 = Math.max(0, Math.round(Math.min(a.y, b.y) * scale));
  const x1 = Math.min(imgW, Math.round(Math.max(a.x, b.x) * scale));
  const y1 = Math.min(imgH, Math.round(Math.max(a.y, b.y) * scale));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
