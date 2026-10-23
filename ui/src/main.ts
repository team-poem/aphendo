type CaptureStatus =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done"; added: number }
  | { kind: "failed"; error: string };
type Capture = { id: string; image: string; status: CaptureStatus; created_at: string };
type Todo = {
  id: string;
  capture_id: string;
  title: string;
  due: string | null;
  detail: string | null;
  done: boolean;
  created_at: string;
};
type State = { captures: Capture[]; todos: Todo[] };

declare global {
  interface Window {
    __TAURI__?: { window: { getCurrentWindow(): { close(): Promise<void> } } };
  }
}

// The Tauri webview serves the UI from its own origin; the browser and Vite dev share /api.
const API =
  location.protocol === "tauri:" || location.hostname === "tauri.localhost" ? "http://127.0.0.1:47321" : "";

const $ = (id: string) => document.getElementById(id)!;
const msg = (text: string) => ($("msg").textContent = text);

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const GROUPS = ["지난", "오늘", "이번주", "나중", "마감없음", "완료"] as const;
type Group = (typeof GROUPS)[number];

function groupOf(t: Todo, today: Date): Group {
  if (t.done) return "완료";
  if (!t.due) return "마감없음";
  const now = ymd(today);
  if (t.due < now) return "지난";
  if (t.due === now) return "오늘";
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + ((7 - today.getDay()) % 7));
  return t.due <= ymd(sunday) ? "이번주" : "나중";
}

function dueLabel(due: string): string {
  const d = new Date(`${due}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()} (${"일월화수목금토"[d.getDay()]})`;
}

const imageUrl = (c: Capture) => `${API}/api/captures/${c.id}/image`;

function chip(c: Capture): HTMLElement {
  const s = c.status;
  const el = document.createElement(s.kind === "failed" ? "button" : "span");
  el.className = `chip ${s.kind}`;
  el.textContent = { queued: "대기", running: "분석중…", done: `완료 ${"added" in s ? s.added : 0}개`, failed: "실패 · 재시도" }[s.kind];
  el.title = `${new Date(c.created_at).toLocaleTimeString("ko-KR")}${s.kind === "failed" ? `\n${s.error}` : ""}`;
  if (s.kind === "failed")
    el.onclick = (e) => {
      e.stopPropagation();
      call(`/api/captures/${c.id}/retry`, { method: "POST" });
    };
  return el;
}

function thumb(c: Capture): HTMLElement {
  const el = document.createElement("div");
  el.className = "thumb";
  el.title = "크게 보기";
  const img = document.createElement("img");
  img.src = imageUrl(c);
  img.alt = "";
  img.onerror = () => img.remove();
  el.append(img, chip(c));
  el.onclick = () => openView(c.id);
  return el;
}

// The capture shown in the enlarged view, or null for the todo list.
let viewing: string | null = null;
let current: State = { captures: [], todos: [] };

function openView(id: string | null) {
  viewing = id;
  last = "";
  render(current);
}

function renderView(state: State) {
  const view = $("view");
  const c = viewing && state.captures.find((c) => c.id === viewing);
  view.hidden = !c;
  document.body.classList.toggle("viewing", !!c);
  if (!c) return;
  const back = document.createElement("button");
  back.className = "back";
  back.textContent = "← 목록";
  back.onclick = () => openView(null);
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.append(back, when, chip(c));
  const img = document.createElement("img");
  img.className = "big";
  img.src = imageUrl(c);
  img.alt = "캡처 이미지";
  img.onclick = () => img.classList.toggle("full");
  const todos = state.todos.filter((t) => t.capture_id === c.id);
  const ul = document.createElement("ul");
  ul.append(...todos.map((t) => todoRow(t, false)));
  const h = document.createElement("h2");
  h.textContent = todos.length ? `이 캡처의 할일 ${todos.length}` : "이 캡처에서 나온 할일이 없습니다";
  view.replaceChildren(bar, img, h, ul);
}

function todoRow(t: Todo, withSource = true): HTMLElement {
  const li = document.createElement("li");
  li.className = t.done ? "done" : "";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = t.done;
  box.onchange = () =>
    call(`/api/todos/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: box.checked }),
    });
  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;
  text.append(title);
  const meta = [t.due && dueLabel(t.due), t.detail].filter(Boolean).join(" · ");
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    text.append(m);
  }
  const del = document.createElement("button");
  del.className = "del";
  del.title = "삭제";
  del.textContent = "×";
  del.onclick = () => call(`/api/todos/${t.id}`, { method: "DELETE" });
  if (withSource) {
    const src = document.createElement("button");
    src.className = "src";
    src.title = "원본 캡처 보기";
    src.textContent = "원본";
    src.onclick = () => openView(t.capture_id);
    li.append(box, text, src, del);
  } else li.append(box, text, del);
  return li;
}

let last = "";
function render(state: State) {
  const key = JSON.stringify(state) + ymd(new Date());
  if (key === last) return;
  last = key;
  current = state;

  $("captures").replaceChildren(...[...state.captures].reverse().map(thumb));
  renderView(state);
  const open = state.todos.filter((t) => !t.done).length;
  $("count").textContent = open ? String(open) : "";

  const today = new Date();
  const groups = new Map<Group, Todo[]>(GROUPS.map((g) => [g, []]));
  for (const t of state.todos) groups.get(groupOf(t, today))!.push(t);
  const sections = GROUPS.filter((g) => groups.get(g)!.length).map((g) => {
    const items = groups.get(g)!.sort((a, b) => (a.due ?? "~").localeCompare(b.due ?? "~"));
    const sec = document.createElement("section");
    sec.className = `group g-${GROUPS.indexOf(g)}`;
    const h = document.createElement("h2");
    h.textContent = `${g} ${items.length}`;
    const ul = document.createElement("ul");
    ul.append(...items.map((t) => todoRow(t)));
    sec.append(h, ul);
    return sec;
  });
  if (!sections.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "아직 할일이 없습니다.";
    sections.push(empty);
  }
  $("todos").replaceChildren(...sections);
}

async function refresh() {
  try {
    const r = await fetch(`${API}/api/state`);
    render(await r.json());
  } catch {
    msg("로컬 서버에 연결할 수 없습니다.");
  }
}

async function call(path: string, init: RequestInit) {
  const r = await fetch(`${API}${path}`, init).catch(() => null);
  if (!r?.ok) msg(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
  await refresh();
}

async function asPngOrJpeg(file: Blob): Promise<Blob> {
  if (file.type === "image/png" || file.type === "image/jpeg") return file;
  const bmp = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function upload(files: Blob[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return msg("이미지가 아닙니다. 캡처 후 Ctrl+V 하세요.");
  msg("");
  for (const f of images) {
    const img = await asPngOrJpeg(f).catch(() => null);
    if (!img) {
      msg("이미지를 읽을 수 없습니다.");
      continue;
    }
    await call("/api/captures", { method: "POST", headers: { "Content-Type": img.type }, body: img });
  }
}

document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items ?? [])].map((i) => i.getAsFile()).filter((f): f is File => !!f);
  e.preventDefault();
  upload(files);
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  upload([...(e.dataTransfer?.files ?? [])]);
});

if (window.__TAURI__) {
  const close = $("close");
  close.hidden = false;
  close.onclick = () => window.__TAURI__!.window.getCurrentWindow().close();
}

refresh();
// ponytail: polling every 1.5s; switch to SSE if the list or the poll rate grows.
setInterval(refresh, 1500);

export {};
