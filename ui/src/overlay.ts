import { API } from "./api";
import { cropRect, type Point } from "./crop";

const { invoke } = (window as unknown as { __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } } }).__TAURI__.core;
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const size = document.getElementById("size")!;
const hint = document.getElementById("hint")!;

let done = false;
const finish = () => {
  done = true;
  invoke("finish_snip");
};

const img = new Image();
img.src = URL.createObjectURL(new Blob([await invoke<ArrayBuffer>("frozen_image")], { type: "image/png" }));
await img.decode();
canvas.width = img.naturalWidth;
canvas.height = img.naturalHeight;
// Image pixels per CSS pixel; covers any DPI without asking the OS.
const scale = () => img.naturalWidth / window.innerWidth;

function draw(a?: Point, b?: Point) {
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!a || !b) return;
  const s = scale();
  const x = Math.min(a.x, b.x) * s, y = Math.min(a.y, b.y) * s;
  const w = Math.abs(a.x - b.x) * s, h = Math.abs(a.y - b.y) * s;
  ctx.drawImage(img, x, y, w, h, x, y, w, h);
  ctx.strokeStyle = "#2f6fde";
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeRect(x, y, w, h);
}
draw();

let start: Point | null = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || done) return;
  canvas.setPointerCapture(e.pointerId);
  start = { x: e.clientX, y: e.clientY };
  hint.hidden = true;
});
canvas.addEventListener("pointermove", (e) => {
  if (!start) return;
  const p = { x: e.clientX, y: e.clientY };
  draw(start, p);
  const r = cropRect(start, p, scale(), img.naturalWidth, img.naturalHeight);
  size.hidden = !r;
  if (r) {
    size.textContent = `${r.w} × ${r.h}`;
    size.style.left = `${Math.min(start.x, p.x)}px`;
    size.style.top = `${Math.max(0, Math.min(start.y, p.y) - 26)}px`;
  }
});
canvas.addEventListener("pointerup", async (e) => {
  if (!start) return;
  const r = cropRect(start, { x: e.clientX, y: e.clientY }, scale(), img.naturalWidth, img.naturalHeight);
  start = null;
  if (!r) return finish();
  done = true;
  const out = new OffscreenCanvas(r.w, r.h);
  out.getContext("2d")!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const body = await out.convertToBlob({ type: "image/png" });
  const res = await fetch(`${API}/api/captures`, { method: "POST", headers: { "Content-Type": "image/png" }, body }).catch(() => null);
  if (res?.ok) return finish();
  hint.textContent = `저장 실패: ${res ? await res.text() : "로컬 서버에 연결할 수 없음"} · Esc로 닫기`;
  hint.hidden = false;
});
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  finish();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") finish();
});
