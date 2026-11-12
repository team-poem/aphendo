// Six colors make a theme. The UI is written with white/N alpha utilities, so `text` drives every text and
// line color, and `accent` replaces the orange scale everywhere it is used.
export type Colors = { side: string; body: string; card: string; popup: string; text: string; accent: string };
export type Preset = "black" | "white" | "bw" | "pastel" | "recommended";
export type ThemeChoice = { preset: Preset; custom: Partial<Colors> };

export const PRESETS: Record<Preset, { label: string; colors: Colors }> = {
  black: { label: "블랙", colors: { side: "#17181b", body: "#1d1e22", card: "#25272c", popup: "#26282d", text: "#f1f1f3", accent: "#f97316" } },
  white: { label: "화이트", colors: { side: "#f4f4f5", body: "#ffffff", card: "#ffffff", popup: "#ffffff", text: "#18181b", accent: "#ea580c" } },
  bw: { label: "블랙 & 화이트", colors: { side: "#18181b", body: "#ffffff", card: "#f6f6f7", popup: "#ffffff", text: "#18181b", accent: "#ea580c" } },
  pastel: { label: "파스텔", colors: { side: "#eceef8", body: "#fbf9f5", card: "#ffffff", popup: "#ffffff", text: "#2a2c40", accent: "#5f68c6" } },
  recommended: { label: "추천", colors: { side: "#e6eaf0", body: "#f3f5f8", card: "#ffffff", popup: "#ffffff", text: "#1b2a4a", accent: "#0b7f74" } },
};

export const COLOR_LABEL: Record<keyof Colors, string> = { side: "왼쪽 영역", body: "본문", card: "카드", popup: "팝업", text: "글자", accent: "강조색" };

export const colorsOf = (t: ThemeChoice): Colors => ({ ...PRESETS[t.preset].colors, ...t.custom });

export function readTheme(): ThemeChoice {
  try {
    const t = JSON.parse(localStorage.getItem("themeChoice") ?? "null");
    if (t && t.preset in PRESETS) return { preset: t.preset, custom: t.custom ?? {} };
    // Before the five themes there was only a dark/light toggle.
    return { preset: localStorage.getItem("theme") === "light" ? "white" : "black", custom: {} };
  } catch {
    return { preset: "black", custom: {} };
  }
}

export function saveTheme(t: ThemeChoice) {
  try {
    localStorage.setItem("themeChoice", JSON.stringify(t));
  } catch {}
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const INK = { dark: "#16181d", light: "#f4f5f7" };
/** Whichever of near-black and near-white reads better on `bg`. */
export const inkFor = (bg: string) => (contrast(INK.dark, bg) >= contrast(INK.light, bg) ? INK.dark : INK.light);

const mix = (hex: string, to: string, p: number) => {
  const [a, b] = [rgb(hex), rgb(to)];
  return "#" + a.map((v, i) => Math.round(v * (1 - p) + b[i] * p).toString(16).padStart(2, "0")).join("");
};

/** Pairs below the WCAG reading threshold, and a corrected copy of the colors. */
export function checkContrast(c: Colors) {
  const issues: string[] = [];
  for (const k of ["body", "card", "popup"] as const) if (contrast(c.text, c[k]) < 4.5) issues.push(`${COLOR_LABEL[k]} 위 글자 대비가 ${contrast(c.text, c[k]).toFixed(1)}:1로 낮습니다 (권장 4.5:1)`);
  if (contrast("#ffffff", c.accent) < 3) issues.push(`강조색 버튼의 흰 글자 대비가 ${contrast("#ffffff", c.accent).toFixed(1)}:1로 낮습니다 (권장 3:1)`);
  let accent = c.accent;
  for (let i = 0; i < 10 && contrast("#ffffff", accent) < 3; i++) accent = mix(accent, "#000000", 0.12);
  const worst = (["body", "card", "popup"] as const).map((k) => c[k]).sort((a, b) => contrast(c.text, a) - contrast(c.text, b))[0];
  const text = contrast(c.text, worst) < 4.5 ? inkFor(c.body) : c.text;
  return { issues, fixed: { ...c, text, accent } };
}

/** Writes the colors as CSS variables on <html>. The side panel gets its own text color when the theme's
 *  text would not read on it (the 블랙 & 화이트 dark side), and is flagged so `light:` variants follow it. */
export function applyColors(c: Colors) {
  const root = document.documentElement;
  const light = luminance(c.body) > 0.4;
  const sideText = contrast(c.text, c.side) >= 4.5 ? c.text : inkFor(c.side);
  const sideLight = luminance(c.side) > 0.4;
  const vars: Record<string, string> = {
    "--color-white": c.text,
    "--color-foreground": c.text,
    "--color-background": c.body,
    "--color-surface": c.card,
    "--color-popup": c.popup,
    "--color-side": c.side,
    "--side-text": sideText,
    "--color-orange-300": mix(c.accent, "#ffffff", 0.4),
    "--color-orange-400": mix(c.accent, "#ffffff", 0.2),
    "--color-orange-500": c.accent,
    "--color-orange-600": mix(c.accent, "#000000", 0.15),
    "--color-orange-700": mix(c.accent, "#000000", 0.3),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.classList.toggle("light", light);
  root.dataset.side = sideLight === light ? "same" : sideLight ? "light" : "dark";
}
