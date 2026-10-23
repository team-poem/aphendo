import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { format, isSameDay, parse, startOfToday } from "date-fns";
import { ko } from "date-fns/locale";
import { X } from "lucide-react";
import { API } from "./api";
import { FullScreenCalendar, type CalendarData } from "@/components/ui/fullscreen-calendar";
import { cn } from "@/lib/utils";

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
    __TAURI__?: {
      core: { invoke(cmd: string): Promise<unknown> };
      window: { getCurrentWindow(): { close(): Promise<void> } };
    };
  }
}

const tauri = window.__TAURI__;
const dueDate = (due: string) => parse(due, "yyyy-MM-dd", new Date());
const imageUrl = (id: string) => `${API}/api/captures/${id}/image`;

// One calendar cell per due date; the todo id doubles as the event id so rows can find their todo.
function toCalendarData(todos: Todo[]): CalendarData[] {
  const doneLast = new Map<string, Todo[]>();
  for (const t of todos) if (t.due) doneLast.set(t.due, [...(doneLast.get(t.due) ?? []), t]);
  return [...doneLast].map(([due, ts]) => ({
    day: dueDate(due),
    events: ts.sort((a, b) => Number(a.done) - Number(b.done)).map((t) => ({ id: t.id, name: t.title, time: "", datetime: due, done: t.done })),
  }));
}

let setMsg: (m: string) => void = () => {};

async function call(path: string, init: RequestInit) {
  const r = await fetch(`${API}${path}`, init).catch(() => null);
  if (!r?.ok) setMsg(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
  refresh();
}

let refresh: () => void = () => {};

async function asPngOrJpeg(file: Blob): Promise<Blob> {
  if (file.type === "image/png" || file.type === "image/jpeg") return file;
  const bmp = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function upload(files: Blob[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return setMsg("이미지가 아닙니다. 캡처 후 Ctrl+V 하세요.");
  setMsg("");
  for (const f of images) {
    const img = await asPngOrJpeg(f).catch(() => null);
    if (!img) {
      setMsg("이미지를 읽을 수 없습니다.");
      continue;
    }
    await call("/api/captures", { method: "POST", headers: { "Content-Type": img.type }, body: img });
  }
}

function Chip({ c }: { c: Capture }) {
  const s = c.status;
  const label = { queued: "대기", running: "분석중…", done: `완료 ${s.kind === "done" ? s.added : 0}개`, failed: "실패 · 재시도" }[s.kind];
  const title = `${new Date(c.created_at).toLocaleTimeString("ko-KR")}${s.kind === "failed" ? `\n${s.error}` : ""}`;
  const cls = cn(
    "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
    { queued: "bg-white/10 text-white/70", running: "bg-sky-500/20 text-sky-300", done: "bg-emerald-500/20 text-emerald-300", failed: "bg-red-500/25 text-red-300" }[s.kind],
  );
  if (s.kind !== "failed") return <span className={cls} title={title}>{label}</span>;
  return (
    <button
      className={cn(cls, "cursor-pointer hover:bg-red-500/40")}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        call(`/api/captures/${c.id}/retry`, { method: "POST" });
      }}
    >
      {label}
    </button>
  );
}

function TodoRow({ t, onSource }: { t: Todo; onSource?: (id: string) => void }) {
  const meta = [t.due && format(dueDate(t.due), "M/d (EEE)", { locale: ko }), t.detail].filter(Boolean).join(" · ");
  return (
    <li className="group flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-white/[0.03]">
      <input
        type="checkbox"
        className="mt-0.5 accent-orange-500"
        checked={t.done}
        onChange={(e) =>
          call(`/api/todos/${t.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ done: e.target.checked }),
          })
        }
      />
      <div className="min-w-0 flex-1 text-sm">
        <div className={cn("break-words", t.done && "text-white/40 line-through")}>{t.title}</div>
        {meta && <div className="mt-0.5 break-words text-xs text-white/40">{meta}</div>}
      </div>
      {onSource && (
        <button className="shrink-0 rounded px-1.5 text-xs text-white/50 hover:bg-white/10 hover:text-white" title="원본 캡처 보기" onClick={() => onSource(t.capture_id)}>
          원본
        </button>
      )}
      <button className="shrink-0 rounded px-1 text-white/40 hover:bg-white/10 hover:text-red-300" title="삭제" onClick={() => call(`/api/todos/${t.id}`, { method: "DELETE" })}>
        <X size={14} />
      </button>
    </li>
  );
}

function TodoList({ title, todos, empty, onSource }: { title: string; todos: Todo[]; empty: string; onSource: (id: string) => void }) {
  return (
    <section className="border-b border-white/[0.06] p-3">
      <h2 className="mb-1 text-xs font-semibold text-white/50">
        {title} <span className="text-white/30">{todos.length || ""}</span>
      </h2>
      {todos.length ? (
        <ul>{todos.map((t) => <TodoRow key={t.id} t={t} onSource={onSource} />)}</ul>
      ) : (
        <p className="px-2 py-1 text-xs text-white/30">{empty}</p>
      )}
    </section>
  );
}

function CaptureView({ c, todos, onClose }: { c: Capture; todos: Todo[]; onClose: () => void }) {
  const [full, setFull] = useState(false);
  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-[#050505]">
      <div data-tauri-drag-region className="flex items-center gap-3 border-b border-white/[0.06] p-3 text-sm">
        <button className="rounded-sm px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose}>
          ← 달력
        </button>
        <span className="text-white/40">{new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</span>
        <Chip c={c} />
      </div>
      <img
        src={imageUrl(c.id)}
        alt="캡처 이미지"
        onClick={() => setFull(!full)}
        className={cn("mx-auto cursor-zoom-in p-3", full ? "max-w-none cursor-zoom-out" : "max-h-[55vh] max-w-full object-contain")}
      />
      <h2 className="px-3 pt-2 text-xs font-semibold text-white/50">
        {todos.length ? `이 캡처의 할일 ${todos.length}` : "이 캡처에서 나온 할일이 없습니다"}
      </h2>
      <ul className="p-1">{todos.map((t) => <TodoRow key={t.id} t={t} />)}</ul>
    </div>
  );
}

// Wide: lives atop the side panel so the calendar gets the full window height. Narrow: atop everything.
function TitleBar({ open, className }: { open: number; className: string }) {
  return (
    <header data-tauri-drag-region className={cn("flex h-9 shrink-0 select-none items-center gap-2 border-b border-white/[0.06] px-3", className)}>
      <h1 data-tauri-drag-region className="flex-1 text-sm font-semibold">
        할일 캡처 {open > 0 && <span className="ml-1 rounded-full bg-orange-500 px-1.5 text-xs text-white">{open}</span>}
      </h1>
      {tauri && (
        <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기" onClick={() => tauri.window.getCurrentWindow().close()}>
          <X size={16} />
        </button>
      )}
    </header>
  );
}

function App() {
  const [state, setState] = useState<State>({ captures: [], todos: [] });
  const [msg, setMsgState] = useState("");
  const [selected, setSelected] = useState(startOfToday);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  setMsg = setMsgState;

  useEffect(() => {
    let last = "";
    refresh = async () => {
      try {
        const r = await fetch(`${API}/api/state`);
        const text = await r.text();
        if (text !== last) setState(JSON.parse((last = text)));
      } catch {
        setMsgState("로컬 서버에 연결할 수 없습니다.");
      }
    };
    refresh();
    // ponytail: polling every 1.5s; switch to SSE if the list or the poll rate grows.
    const timer = setInterval(refresh, 1500);

    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])].map((i) => i.getAsFile()).filter((f): f is File => !!f);
      e.preventDefault();
      upload(files);
    };
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      upload([...(e.dataTransfer?.files ?? [])]);
    };
    document.addEventListener("paste", paste);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      clearInterval(timer);
      document.removeEventListener("paste", paste);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, []);

  const data = useMemo(() => toCalendarData(state.todos), [state.todos]);
  const doneLast = (a: Todo, b: Todo) => Number(a.done) - Number(b.done) || a.created_at.localeCompare(b.created_at);
  const dayTodos = state.todos.filter((t) => t.due && isSameDay(dueDate(t.due), selected)).sort(doneLast);
  const noDue = state.todos.filter((t) => !t.due).sort(doneLast);
  const open = state.todos.filter((t) => !t.done).length;
  const view = viewing ? state.captures.find((c) => c.id === viewing) : undefined;

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar open={open} className="md:hidden" />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="flex shrink-0 flex-col md:min-w-0 md:flex-1 md:overflow-y-auto">
          <FullScreenCalendar
            data={data}
            selectedDay={selected}
            onSelectDay={setSelected}
            onNewEvent={tauri && (() => tauri.core.invoke("start_snip").catch((e) => setMsgState(`화면 캡처 실패: ${e}`)))}
          />
        </div>

        <aside className="border-white/[0.06] md:w-80 md:shrink-0 md:overflow-y-auto md:border-l">
          <TitleBar open={open} className="hidden md:flex" />
          <section className="border-b border-white/[0.06] p-3">
            <p className="mb-2 text-xs text-white/40">
              {tauri ? "Alt+Shift+S 또는 캡처 버튼으로 영역 캡처. 다른 도구로 찍었다면 Ctrl+V, 이미지 파일은 끌어다 놓기." : "캡처한 이미지를 Ctrl+V 하거나 이미지 파일을 끌어다 놓으면 할일을 뽑습니다."}
            </p>
            {state.captures.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {[...state.captures].reverse().map((c) => (
                  <div
                    key={c.id}
                    title="크게 보기"
                    onClick={() => setViewing(c.id)}
                    className="relative h-16 w-24 shrink-0 cursor-pointer overflow-hidden rounded-sm border border-white/[0.08] bg-white/[0.03] hover:border-orange-500/40"
                  >
                    <img src={imageUrl(c.id)} alt="" className="h-full w-full object-cover object-top" onError={(e) => e.currentTarget.remove()} />
                    <div className="absolute bottom-1 left-1">
                      <Chip c={c} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <TodoList title={format(selected, "M월 d일 (EEE)", { locale: ko })} todos={dayTodos} empty="이 날 마감인 할일이 없습니다." onSource={setViewing} />
          <TodoList title="마감 없음" todos={noDue} empty="마감 없는 할일이 없습니다." onSource={setViewing} />
          {msg && <p className="p-3 text-xs text-red-300">{msg}</p>}
        </aside>
      </div>

      {view && <CaptureView c={view} todos={state.todos.filter((t) => t.capture_id === view.id)} onClose={() => setViewing(null)} />}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-md border-2 border-dashed border-orange-500/60 bg-orange-500/[0.06] text-sm text-orange-300">
          여기에 놓으면 분석합니다
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
