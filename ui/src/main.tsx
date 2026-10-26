import { StrictMode, useEffect, useMemo, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { endOfDay, format, isToday, isWithinInterval, parse, startOfDay, startOfToday } from "date-fns";
import { ko } from "date-fns/locale";
import { Settings as Gear, Minus, X } from "lucide-react";
import { API } from "./api";
import { configured, fetchConfig, Settings, type ConfigView } from "./settings";
import { FullScreenCalendar, type CalendarData } from "@/components/ui/fullscreen-calendar";
import { cn } from "@/lib/utils";
import { TodoDetail, type Todo } from "./todo-detail";

type CaptureStatus =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done"; added: number }
  | { kind: "failed"; error: string };
type Capture = { id: string; image: string; status: CaptureStatus; created_at: string };
type State = { captures: Capture[]; todos: Todo[] };

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke(cmd: string): Promise<unknown> };
      app: { getVersion(): Promise<string> };
      window: { getCurrentWindow(): { close(): Promise<void>; minimize(): Promise<void>; startDragging(): Promise<void> } };
    };
  }
}

const tauri = window.__TAURI__;
const dueDate = (due: string) => parse(due, "yyyy-MM-dd", new Date());
type Theme = "dark" | "light";
const readTheme = (): Theme => {
  try {
    return localStorage.getItem("theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};
const applyTheme = (t: Theme) => {
  document.documentElement.classList.toggle("light", t === "light");
  try {
    localStorage.setItem("theme", t);
  } catch {}
};
applyTheme(readTheme());

const imageUrl = (id: string) => `${API}/api/captures/${id}/image`;

// Any empty spot of a top bar moves the window; data-tauri-drag-region only catches the tagged element itself.
const dragWindow = (e: MouseEvent) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, a, textarea, select")) return;
  tauri?.window.getCurrentWindow().startDragging();
};

// Open first, then more stars, then oldest.
const byPriority = (a: Todo, b: Todo) => Number(a.done) - Number(b.done) || b.priority - a.priority || a.created_at.localeCompare(b.created_at);

// Done todos live in the 완료 section of the day they were checked off. Older ones have no stamp.
const doneDay = (t: Todo) => (t.done_at ? new Date(t.done_at) : t.due ? dueDate(t.due) : new Date(t.created_at));
// Soonest due first; no due date goes last.
const byDue = (a: Todo, b: Todo) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || byPriority(a, b);

// One calendar cell per due date of an open todo; the todo id doubles as the event id so rows can find their todo.
function toCalendarData(todos: Todo[]): CalendarData[] {
  const byDay = new Map<string, Todo[]>();
  for (const t of todos) if (t.due && !t.done) byDay.set(t.due, [...(byDay.get(t.due) ?? []), t]);
  return [...byDay].map(([due, ts]) => ({
    day: dueDate(due),
    events: ts.sort(byPriority).map((t) => ({ id: t.id, name: t.title, time: "", datetime: due, done: t.done, priority: t.priority })),
  }));
}

let setMsg: (m: string) => void = () => {};

async function call(path: string, init: RequestInit) {
  const r = await fetch(`${API}${path}`, init).catch(() => null);
  if (!r?.ok) setMsg(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
  refresh();
}

let refresh: () => void = () => {};
let openTodo: (id: string) => void = () => {};
// Reopening moves a todo from the day it was done back to its due day; follow it there so it doesn't seem to vanish.
let showDay: (d: Date) => void = () => {};
const setDone = (t: Todo, done: boolean) => {
  patchTodo(t.id, { done });
  if (!done && t.due) showDay(dueDate(t.due));
};

const patchTodo = (id: string, body: { done?: boolean; priority?: number }) =>
  call(`/api/todos/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
  // "할일 N개 추출", not "완료": this counts what was read from the capture, not work the user finished.
  const label = { queued: "분석 대기", running: "분석중…", done: `할일 ${s.kind === "done" ? s.added : 0}개 추출`, failed: "분석 실패 · 재시도" }[s.kind];
  const title = `${new Date(c.created_at).toLocaleTimeString("ko-KR")}${s.kind === "failed" ? `\n${s.error}` : ""}`;
  const cls = cn(
    "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
    { queued: "bg-white/10 text-white/70", running: "bg-sky-500/20 text-sky-300 light:text-sky-700", done: "bg-white/10 text-white/70", failed: "bg-red-500/25 text-red-300 light:text-red-700" }[s.kind],
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

// Clicking the current level clears it.
function Stars({ t }: { t: Todo }) {
  return (
    <div className="flex shrink-0" title="중요도">
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          aria-label={`중요도 ${n}`}
          className={cn("px-px text-sm leading-none", n <= t.priority ? "text-amber-400" : "text-white/20 hover:text-amber-300/70")}
          onClick={() => patchTodo(t.id, { priority: t.priority === n ? 0 : n })}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function TodoRow({ t, onSource }: { t: Todo; onSource?: (id: string) => void }) {
  // Kept to one line; every field is in the detail dialog.
  const meta = [
    t.due && `마감 ${format(dueDate(t.due), "M/d (EEE)", { locale: ko })}`,
    t.done_at && `완료 ${format(new Date(t.done_at), "M/d HH:mm")}`,
    t.sender,
  ].filter(Boolean).join(" · ");
  return (
    <li className="group flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-white/[0.03]">
      <input
        type="checkbox"
        className="mt-0.5 accent-orange-500"
        checked={t.done}
        onChange={(e) => setDone(t, e.target.checked)}
      />
      <div className="min-w-0 flex-1 cursor-pointer text-sm" title="눌러서 확인·수정" onClick={() => openTodo(t.id)}>
        <div className={cn("break-words", t.done && "text-white/40 line-through")}>{t.title}</div>
        {meta && <div className="mt-0.5 truncate text-xs text-white/40">{meta}</div>}
      </div>
      <Stars t={t} />
      {onSource && t.capture_id && (
        <button className="shrink-0 rounded px-1.5 text-xs text-white/50 hover:bg-white/10 hover:text-white" title="원본 캡처 보기" onClick={() => onSource(t.capture_id)}>
          원본
        </button>
      )}
      <button className="shrink-0 rounded px-1 text-white/40 hover:bg-white/10 hover:text-red-300 light:hover:text-red-600" title="삭제" onClick={() => call(`/api/todos/${t.id}`, { method: "DELETE" })}>
        <X size={14} />
      </button>
    </li>
  );
}

function CaptureView({ c, todos, onClose }: { c: Capture; todos: Todo[]; onClose: () => void }) {
  const [full, setFull] = useState(false);
  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-background">
      <div onMouseDown={dragWindow} className="flex select-none items-center gap-3 border-b border-white/[0.06] p-3 text-sm">
        <button className="rounded-sm px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose}>
          ← 달력
        </button>
        <span className="text-white/40">{new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</span>
        <Chip c={c} />
        {(c.status.kind === "done" || c.status.kind === "failed") && (
          <button
            className="ml-auto rounded-sm border border-white/[0.1] px-2 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            title="이 캡처에서 할일을 다시 뽑습니다. 지운 할일도 다시 생깁니다."
            onClick={() => call(`/api/captures/${c.id}/retry`, { method: "POST" })}
          >
            다시 분석
          </button>
        )}
      </div>
      <img
        src={imageUrl(c.id)}
        alt="캡처 이미지"
        onClick={() => setFull(!full)}
        className={cn("mx-auto cursor-zoom-in p-3", full ? "max-w-none cursor-zoom-out" : "max-h-[55vh] max-w-full object-contain")}
      />
      <h2 className="px-3 pt-2 text-xs font-semibold text-white/50">
        {todos.length ? `이 캡처의 할일 ${todos.length}` : "이 캡처에서 나온 할일이 없습니다. 위의 다시 분석을 눌러 보세요."}
      </h2>
      <ul className="p-1">{todos.map((t) => <TodoRow key={t.id} t={t} />)}</ul>
    </div>
  );
}

// ponytail: checks the release feed every 30 minutes; the widget tends to stay open for days.
function UpdateButton() {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tauri) return;
    const check = () => (tauri.core.invoke("check_update") as Promise<string | null>).then(setVersion, () => {});
    check();
    const timer = setInterval(check, 30 * 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!tauri || !version) return null;
  return (
    <button
      disabled={busy}
      className="rounded bg-orange-500 px-2 py-0.5 text-xs font-medium text-[#fff] hover:bg-orange-600 disabled:opacity-60"
      title="새 버전을 받아 설치하고 다시 시작합니다"
      onClick={() => {
        setBusy(true);
        tauri.core.invoke("install_update").catch((e) => {
          setBusy(false);
          setMsg(`업데이트 실패: ${e}`);
        });
      }}
    >
      {busy ? "업데이트 중…" : `v${version} 업데이트`}
    </button>
  );
}

function AppVersion() {
  const [v, setV] = useState("");
  useEffect(() => {
    tauri?.app.getVersion().then(setV);
  }, []);
  return v ? <span className="ml-1 text-xs font-normal text-white/30">v{v}</span> : null;
}

// Wide: lives atop the side panel so the calendar gets the full window height. Narrow: atop everything.
function TitleBar({ open, className, onSettings }: { open: number; className: string; onSettings: () => void }) {
  return (
    <header onMouseDown={dragWindow} className={cn("flex h-9 shrink-0 select-none items-center gap-2 border-b border-white/[0.06] px-3", className)}>
      <h1 className="flex-1 text-sm font-semibold">
        Aphendo
        <AppVersion /> {open > 0 && <span className="ml-1 rounded-full bg-orange-500 px-1.5 text-xs text-[#fff]">{open}</span>}
      </h1>
      <UpdateButton />
      <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="설정" onClick={onSettings}>
        <Gear size={15} />
      </button>
      {tauri && (
        <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="최소화" onClick={() => tauri.window.getCurrentWindow().minimize()}>
          <Minus size={16} />
        </button>
      )}
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
  // 현재: every open todo. 날짜/주간/월간: what is due (할 일) or was finished (완료) in that span.
  const [scope, setScope] = useState<"now" | "day" | "week" | "month">("now");
  const [week, setWeek] = useState(false);
  const [tab, setTab] = useState<"todo" | "done">("todo");
  const [range, setRange] = useState<{ start: Date; end: Date } | null>(null);
  const pickDay = (d: Date) => {
    setSelected(d);
    setScope("day");
  };
  showDay = pickDay;
  const pickScope = (v: string) => {
    if (v === "week" || v === "month") setWeek(v === "week");
    if (v === "now") setTab("todo");
    setScope(v as typeof scope);
  };
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  openTodo = setEditing;
  const [dragging, setDragging] = useState(false);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };
  setMsg = setMsgState;

  useEffect(() => {
    fetchConfig().then((c) => {
      setConfig(c);
      if (c && !configured(c)) setSettingsOpen(true);
    });
  }, []);

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
      // Text pastes (e.g. the token field) must reach the input.
      if (!files.length) return;
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
  const span = scope === "now" ? null : scope === "day" || !range ? { start: selected, end: selected } : range;
  const inSpan = (d: Date) => (span ? isWithinInterval(d, { start: startOfDay(span.start), end: endOfDay(span.end) }) : isToday(d));
  const openTodos = state.todos.filter((t) => !t.done);
  const listed = (scope === "now" ? openTodos : openTodos.filter((t) => t.due && inSpan(dueDate(t.due)))).sort(byDue);
  const doneTodos = state.todos.filter((t) => t.done && inSpan(doneDay(t))).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));
  const shown = tab === "todo" ? listed : doneTodos;
  const open = state.todos.filter((t) => !t.done).length;
  const edited = editing ? state.todos.find((t) => t.id === editing) : undefined;
  const view = viewing ? state.captures.find((c) => c.id === viewing) : undefined;

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar open={open} className="md:hidden" onSettings={() => setSettingsOpen(true)} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="flex shrink-0 flex-col md:min-w-0 md:flex-1 md:overflow-y-auto">
          <FullScreenCalendar
            data={data}
            selectedDay={selected}
            onSelectDay={pickDay}
            theme={theme}
            onToggleTheme={toggleTheme}
            onHeaderMouseDown={dragWindow}
            onEventClick={(id) => setEditing(String(id))}
            onRangeChange={(start, end) => setRange({ start, end })}
            week={week}
            control={
              <select
                value={scope}
                onChange={(e) => pickScope(e.target.value)}
                className="h-9 w-full rounded-sm border-[0.5px] border-white/[0.06] bg-surface px-2 text-xs text-white/80 md:w-auto"
                title="목록에 보일 할일"
              >
                <option value="now">현재 · 미완료 전체</option>
                {scope === "day" && <option value="day">{format(selected, "M/d (EEE)", { locale: ko })}</option>}
                <option value="week">주간</option>
                <option value="month">월간</option>
              </select>
            }
            onAdd={() => setAdding(true)}
            onNewEvent={tauri && (() => tauri.core.invoke("start_snip").catch((e) => setMsgState(`화면 캡처 실패: ${e}`)))}
          />
        </div>

        <aside className="border-white/[0.06] md:w-80 md:shrink-0 md:overflow-y-auto md:border-l">
          <TitleBar open={open} className="hidden md:flex" onSettings={() => setSettingsOpen(true)} />
          {config && !configured(config) && (
            <button className="block w-full border-b border-white/[0.06] bg-orange-500/10 p-3 text-left text-xs text-orange-300 light:text-orange-700 hover:bg-orange-500/20" onClick={() => setSettingsOpen(true)}>
              접속 토큰이 없어 캡처를 분석할 수 없습니다. ⚙ 설정을 눌러 입력하세요.
            </button>
          )}
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
          <div className="flex gap-1 border-b border-white/[0.06] px-3 pt-2">
            {(["todo", "done"] as const).map((k) => (
              <button
                key={k}
                className={cn("-mb-px border-b-2 px-3 py-1.5 text-xs font-semibold", tab === k ? "border-orange-500 text-white" : "border-transparent text-white/40 hover:text-white/70")}
                onClick={() => setTab(k)}
                title={k === "done" && scope === "now" ? "오늘 완료한 할일" : undefined}
              >
                {k === "todo" ? `할 일 ${listed.length}` : `완료 ${doneTodos.length}`}
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="p-1">{shown.map((t) => <TodoRow key={t.id} t={t} onSource={setViewing} />)}</ul>
          ) : (
            <p className="p-4 text-xs text-white/30">{tab === "todo" ? "남은 할일이 없습니다." : "완료한 할일이 없습니다."}</p>
          )}
          {msg && <p className="p-3 text-xs text-red-300 light:text-red-700">{msg}</p>}
        </aside>
      </div>

      {view && <CaptureView c={view} todos={state.todos.filter((t) => t.capture_id === view.id)} onClose={() => setViewing(null)} />}
      {adding && (
        <TodoDetail
          todo={{ id: "", capture_id: "", title: "", due: format(selected, "yyyy-MM-dd"), sender: null, method: null, contact: null, detail: null, done: false, done_at: null, priority: 0, created_at: "" }}
          imageUrl={null}
          onClose={() => setAdding(false)}
          onChanged={refresh}
          onReopen={showDay}
        />
      )}
      {edited && <TodoDetail key={edited.id} todo={edited} imageUrl={edited.capture_id ? imageUrl(edited.capture_id) : null} onClose={() => setEditing(null)} onChanged={refresh} onReopen={showDay} />}
      {settingsOpen && <Settings config={config} onClose={() => setSettingsOpen(false)} onSaved={setConfig} />}
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
