import { API } from "./api";
import { cropRect, type Point } from "./crop";

const { invoke } = (window as unknown as { __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } } }).__TAURI__.core;
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const size = document.getElementById("size")!;
const hint = document.getElementById("hint")!;
const bar = document.getElementById("bar")!;

let done = false;
const finish = () => {
  done = true;
  invoke("finish_snip");
};

const raw = await invoke<ArrayBuffer>("frozen_image");
const [fw, fh] = new Uint32Array(raw, 0, 2);
const img = await createImageBitmap(new ImageData(new Uint8ClampedArray(raw, 8), fw, fh));
canvas.width = img.width;
canvas.height = img.height;
// Image pixels per CSS pixel; covers any DPI without asking the OS.
const scale = () => img.width / window.innerWidth;

function draw(a?: Point, b?: Point) {
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!a || !b) return;
  const s = scale();
  const x = Math.min(a.x, b.x) * s, y = Math.min(a.y, b.y) * s;
  const w = Math.abs(a.x - b.x) * s, h = Math.abs(a.y - b.y) * s;
  ctx.drawImage(img, x, y, w, h, x, y, w, h);
  ctx.strokeStyle = "#2f6fde";
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(x - s, y - s, w + 2 * s, h + 2 * s);
}
draw();

let start: Point | null = null;
let picked: ReturnType<typeof cropRect> = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || done) return;
  canvas.setPointerCapture(e.pointerId);
  start = { x: e.clientX, y: e.clientY };
  picked = null;
  bar.hidden = true;
  hint.hidden = true;
});
canvas.addEventListener("pointermove", (e) => {
  if (!start) return;
  const p = { x: e.clientX, y: e.clientY };
  draw(start, p);
  const r = cropRect(start, p, scale(), img.width, img.height);
  size.hidden = !r;
  if (r) {
    size.textContent = `${r.w} × ${r.h}`;
    size.style.left = `${Math.min(start.x, p.x)}px`;
    size.style.top = `${Math.max(0, Math.min(start.y, p.y) - 26)}px`;
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (!start) return;
  const end = { x: e.clientX, y: e.clientY };
  const from = start;
  start = null;
  picked = cropRect(from, end, scale(), img.width, img.height);
  if (!picked) {
    draw();
    size.hidden = true;
    hint.hidden = false;
    return;
  }
  bar.hidden = false;
  const right = Math.max(from.x, end.x), bottom = Math.max(from.y, end.y);
  bar.style.left = `${Math.max(8, Math.min(right, window.innerWidth - 8) - bar.offsetWidth)}px`;
  bar.style.top = `${bottom + 52 > window.innerHeight ? bottom - 44 : bottom + 8}px`;
});

async function submit() {
  if (!picked || done) return;
  const r = picked;
  done = true;
  bar.hidden = true;
  const out = new OffscreenCanvas(r.w, r.h);
  out.getContext("2d")!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const body = await out.convertToBlob({ type: "image/png" });
  const res = await fetch(`${API}/api/captures`, { method: "POST", headers: { "Content-Type": "image/png" }, body }).catch(() => null);
  if (res?.ok) return finish();
  hint.textContent = `저장 실패: ${res ? await res.text() : "로컬 서버에 연결할 수 없음"} · Esc로 닫기`;
  hint.hidden = false;
}
document.getElementById("ok")!.addEventListener("click", submit);
document.getElementById("cancel")!.addEventListener("click", finish);
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  finish();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") finish();
  if (e.key === "Enter") submit();
});
