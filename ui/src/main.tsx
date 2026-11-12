import { StrictMode, useEffect, useMemo, useRef, useState, type MouseEvent, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { addMonths, addWeeks, endOfDay, endOfMonth, endOfWeek, format, isSameMonth, isToday, isWithinInterval, startOfDay, startOfMonth, startOfToday, startOfWeek } from "date-fns";
import { ko } from "date-fns/locale";
import { AlertTriangle, BarChart3, Camera, ChevronLeft, ChevronRight, Copy, Home, Images, List, Maximize2, Menu, Minus, NotebookPen, Plus, Settings as Gear, Shrink, X } from "lucide-react";
import { API, imageUrl, type Capture } from "./api";
import { configured, fetchConfig, Settings, type ConfigView } from "./settings";
import { MiniCalendar, MonthGrid, WeekBoard, workWeek } from "./calendar";
import { DuplicateReview, type Pending } from "./duplicates";
import { EvidenceCard } from "./evidence";
import { useLayer } from "./layer";
import { applyColors, colorsOf, readTheme } from "./theme";
import { actions, byOrder, dueDate, evidenceOf, isOverdue, TodoRow } from "./todo-item";
import { WeeklyReport, type Report } from "./weekly";
import { FollowUpTimeline } from "./timeline";
import { cn } from "@/lib/utils";
import { FinishTodo, TodoDetail, type Todo } from "./todo-detail";

type CallNote = { id: string; who: string; memo: string; created_at: string };
type State = { captures: Capture[]; todos: Todo[]; calls?: CallNote[]; pending?: Pending[]; reports?: Report[] };
type Page = "home" | "stats" | "weekly";

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke(cmd: string): Promise<unknown> };
      app: { getVersion(): Promise<string> };
      window: {
        getCurrentWindow(): TauriWindow;
        LogicalSize: new (w: number, h: number) => unknown;
        PhysicalPosition: new (x: number, y: number) => unknown;
        currentMonitor(): Promise<{ position: { x: number; y: number } } | null>;
      };
    };
  }
}

type TauriWindow = {
  close(): Promise<void>;
  minimize(): Promise<void>;
  startDragging(): Promise<void>;
  setSize(s: unknown): Promise<void>;
  setMinSize(s: unknown): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>;
  innerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
  outerPosition(): Promise<{ x: number; y: number }>;
  setPosition(p: unknown): Promise<void>;
};

const tauri = window.__TAURI__;
applyColors(colorsOf(readTheme()));

const TABS = ["todo", "done", "calls"] as const;
type Tab = (typeof TABS)[number];
// Per-PC tab order, dragged into place by the user.
const readTabOrder = (): Tab[] => {
  try {
    const o = JSON.parse(localStorage.getItem("tabOrder") ?? "null");
    if (Array.isArray(o) && o.length === TABS.length && TABS.every((t) => o.includes(t))) return o;
  } catch {}
  return [...TABS];
};

// Width of the list drawer in px, dragged by its edge and kept per PC.
const readSideWidth = () => {
  try {
    return Number(localStorage.getItem("sideWidth")) || 360;
  } catch {
    return 360;
  }
};
const clampSide = (w: number) => Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.9));

// Any empty spot of a top bar moves the window; data-tauri-drag-region only catches the tagged element itself.
const dragWindow = (e: MouseEvent) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, a, textarea, select")) return;
  tauri?.window.getCurrentWindow().startDragging();
};

// The day a todo was checked off. Older ones have no stamp.
const doneDay = (t: Todo) => (t.done_at ? new Date(t.done_at) : t.due ? dueDate(t.due) : new Date(t.created_at));

let setMsg: (m: string) => void = () => {};

async function call(path: string, init: RequestInit) {
  const r = await fetch(`${API}${path}`, init).catch(() => null);
  if (!r?.ok) setMsg(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
  refresh();
}

let refresh: () => void = () => {};
// Reopening moves a todo out of 완료 back to 할 일; follow it there so it doesn't seem to vanish.
let showReopened: (due: string | null) => void = () => {};
// Checking off goes through the completion dialog; unchecking reopens right away.
let finishTodo: (t: Todo) => void = () => {};
actions.setDone = (t, done) => {
  if (done) return finishTodo(t);
  patchTodo(t.id, { done });
  showReopened(t.due);
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

// A paste or drop only stages images; nothing goes to the analyzer until the user confirms.
let stage: (images: Blob[]) => void = () => {};
function upload(files: Blob[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return setMsg("이미지가 아닙니다. 캡처 후 Ctrl+V 하세요.");
  setMsg("");
  stage(images);
}

async function analyze(images: Blob[]) {
  for (const f of images) {
    const img = await asPngOrJpeg(f).catch(() => null);
    if (!img) {
      setMsg("이미지를 읽을 수 없습니다.");
      continue;
    }
    await call("/api/captures", { method: "POST", headers: { "Content-Type": img.type }, body: img });
  }
}

const CAPTURE_HINT = tauri
  ? "Alt+Shift+S 또는 캡처 버튼으로 영역 캡처. 다른 도구로 찍었다면 Ctrl+V, 이미지 파일은 끌어다 놓기."
  : "캡처한 이미지를 Ctrl+V 하거나 이미지 파일을 끌어다 놓으면 할일을 뽑습니다.";

function ConfirmUpload({ images, onClose }: { images: Blob[]; onClose: () => void }) {
  const urls = useMemo(() => images.map((b) => URL.createObjectURL(b)), [images]);
  useEffect(() => () => urls.forEach(URL.revokeObjectURL), [urls]);
  const ok = () => {
    onClose();
    analyze(images);
  };
  return (
    <Modal title={`이 이미지${images.length > 1 ? ` ${images.length}장` : ""}에서 할일을 뽑을까요?`} onClose={onClose}>
      <div className="min-h-0 space-y-2 overflow-y-auto p-3">
        {urls.map((u) => <img key={u} src={u} alt="붙여넣은 이미지" className="mx-auto max-w-full rounded-sm border border-white/[0.08]" />)}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/[0.06] p-3">
        <button className="rounded-sm border border-white/[0.1] px-3 py-1.5 text-sm text-white/70 hover:bg-white/10" onClick={onClose}>
          취소
        </button>
        <button data-autofocus className="rounded-sm bg-orange-500 px-3 py-1.5 text-sm font-medium text-[#fff] hover:bg-orange-600" onClick={ok}>
          분석 시작
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(onClose, ref);
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label={title}
        className={cn("flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-popup shadow-2xl outline-none", wide ? "max-w-3xl" : "max-w-md")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-white/[0.06] px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold">{title}</h2>
          <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기 (Esc)" aria-label="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Chip({ c }: { c: Capture }) {
  const s = c.status;
  const held = s.kind === "done" && s.held ? ` · 중복 확인 ${s.held}` : "";
  // "할일 N개 추출", not "완료": this counts what was read from the capture, not work the user finished.
  const label = { queued: "분석 대기", running: "분석중…", done: `할일 ${s.kind === "done" ? s.added : 0}개 추출${held}`, failed: "분석 실패 · 재시도" }[s.kind];
  const title = `${new Date(c.created_at).toLocaleTimeString("ko-KR")}${s.kind === "failed" ? `\n${s.error}` : ""}`;
  const cls = cn(
    "rounded px-1.5 py-0.5 text-[11px] font-medium leading-none",
    { queued: "bg-black/60 text-[#fff]", running: "bg-sky-600 text-[#fff]", done: "bg-black/60 text-[#fff]", failed: "bg-red-600 text-[#fff]" }[s.kind],
  );
  if (s.kind !== "failed") return <span className={cls} title={title}>{label}</span>;
  return (
    <button
      className={cn(cls, "cursor-pointer hover:bg-red-700")}
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

function DayTodos({ day, todos, onAdd, onClose }: { day: Date; todos: Todo[]; onAdd: () => void; onClose: () => void }) {
  return (
    <Modal title={`${format(day, "M월 d일 (EEE)", { locale: ko })} 할일 ${todos.length}`} onClose={onClose}>
      {todos.length ? (
        <ul className="min-h-0 overflow-y-auto p-1.5">
          {todos.map((t) => (
            <TodoRow key={t.id} t={t} />
          ))}
        </ul>
      ) : (
        <p className="p-4 text-sm text-white/45">이 날짜에 마감인 할일이 없습니다.</p>
      )}
      <button className="border-t border-white/[0.06] p-2.5 text-sm text-white/70 hover:bg-white/[0.04] hover:text-white" onClick={onAdd}>
        + 이 날짜에 할일 추가
      </button>
    </Modal>
  );
}

function CallNotes({ calls }: { calls: CallNote[] }) {
  const [who, setWho] = useState("");
  const [memo, setMemo] = useState("");
  const field = "w-full rounded-sm border border-white/[0.1] bg-white/[0.03] px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500/60";
  const add = async () => {
    if (!who.trim() && !memo.trim()) return;
    await call("/api/calls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ who, memo }) });
    setWho("");
    setMemo("");
  };
  return (
    <div className="p-3">
      <form
        className="mb-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className={field} placeholder="통화 상대" value={who} onChange={(e) => setWho(e.target.value)} />
        <textarea
          className={cn(field, "resize-y")}
          rows={3}
          placeholder="메모 (Ctrl+Enter 저장)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && add()}
        />
        <button type="submit" className="w-full rounded-sm bg-orange-500 py-1.5 text-sm font-medium text-[#fff] hover:bg-orange-600 disabled:opacity-40" disabled={!who.trim() && !memo.trim()}>
          메모 추가
        </button>
      </form>
      {calls.length ? (
        <ul className="space-y-1">
          {[...calls].reverse().map((c) => (
            <li key={c.id} className="group flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-white/[0.03]">
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{c.who || "상대 미기재"}</span>
                  <span className="text-xs text-white/45">{format(new Date(c.created_at), "M/d (EEE) HH:mm", { locale: ko })}</span>
                </div>
                {c.memo && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-white/70">{c.memo}</p>}
              </div>
              <button className="shrink-0 rounded px-1 text-white/40 hover:bg-white/10 hover:text-red-300 light:hover:text-red-600" title="삭제" aria-label="통화 메모 삭제" onClick={() => call(`/api/calls/${c.id}`, { method: "DELETE" })}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-sm text-white/45">통화 메모가 없습니다.</p>
      )}
    </div>
  );
}

/** Every stored capture, newest first; one click opens it large with its todos. */
function CaptureList({ captures, onView, onClose }: { captures: Capture[]; onView: (id: string) => void; onClose: () => void }) {
  return (
    <Modal title={`캡처 목록 ${captures.length}`} onClose={onClose} wide>
      <div className="min-h-0 overflow-y-auto p-3">
        <p className="mb-3 text-sm text-white/55">{CAPTURE_HINT}</p>
        {captures.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[...captures].reverse().map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onView(c.id)} className="group relative block aspect-[4/3] w-full overflow-hidden rounded-md border border-white/[0.1] bg-white/[0.03] hover:border-orange-500/60" title="크게 보기">
                  <img src={imageUrl(c.id)} alt={`${format(new Date(c.created_at), "M/d HH:mm")} 캡처`} className="h-full w-full object-cover object-top" onError={(e) => e.currentTarget.remove()} />
                  <span className="absolute bottom-1.5 left-1.5">
                    <Chip c={c} />
                  </span>
                </button>
                <p className="mt-1 text-xs text-white/50">{format(new Date(c.created_at), "M/d (EEE) HH:mm", { locale: ko })}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/45">아직 캡처가 없습니다.</p>
        )}
      </div>
    </Modal>
  );
}

function CaptureView({ c, todos, onClose }: { c: Capture; todos: Todo[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(onClose, ref);
  const [full, setFull] = useState(false);
  const [sure, setSure] = useState(false);
  const finished = c.status.kind === "done" || c.status.kind === "failed";
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-label="캡처 보기" className="absolute inset-0 z-40 flex flex-col overflow-y-auto bg-background outline-none">
      <div onMouseDown={dragWindow} className="sticky top-0 z-10 flex select-none flex-wrap items-center gap-3 border-b border-white/[0.08] bg-background p-3 text-sm">
        <button className="rounded-sm px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose}>
          ← 돌아가기
        </button>
        <span className="text-white/50">{new Date(c.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</span>
        <Chip c={c} />
        <span className="flex-1" />
        {finished && (
          <button
            className="rounded-sm border border-white/[0.1] px-2 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            title="이 캡처에서 할일을 다시 뽑습니다. 지운 할일도 다시 생깁니다."
            onClick={() => call(`/api/captures/${c.id}/retry`, { method: "POST" })}
          >
            다시 분석
          </button>
        )}
        {finished && (
          <button
            className={cn("rounded-sm border px-2 py-1 text-xs", sure ? "border-red-500/60 bg-red-500/15 text-red-300 light:text-red-700" : "border-white/[0.1] text-white/70 hover:bg-red-500/10 hover:text-red-300")}
            title="캡처 이미지를 지웁니다. 여기서 나온 할일은 남습니다."
            onBlur={() => setSure(false)}
            onClick={() => (sure ? call(`/api/captures/${c.id}`, { method: "DELETE" }).then(onClose) : setSure(true))}
          >
            {sure ? "정말 삭제" : "이미지 삭제"}
          </button>
        )}
        <button className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white" title="닫기 (Esc)" aria-label="닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <img
        src={imageUrl(c.id)}
        alt="캡처 이미지"
        title={full ? "축소" : "원래 크기로 확대"}
        onClick={() => setFull(!full)}
        className={cn("mx-auto cursor-zoom-in p-3", full ? "max-w-none cursor-zoom-out" : "max-h-[60vh] max-w-full object-contain")}
      />
      <h2 className="px-4 pt-2 text-sm font-semibold text-white/60">
        {todos.length ? `이 캡처의 할일 ${todos.length}` : "이 캡처에서 나온 할일이 없습니다. 위의 다시 분석을 눌러 보세요."}
      </h2>
      <ul className="p-2">
        {todos.map((t) => (
          <TodoRow key={t.id} t={t} />
        ))}
      </ul>
    </div>
  );
}

/** One capture as large as the window allows; click for actual size. Opened from evidence, detail and the duplicate check. */
function ImageViewer({ c, onClose }: { c: Capture; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(onClose, ref);
  const [full, setFull] = useState(false);
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-label="원본 캡처" className="absolute inset-0 z-50 flex flex-col bg-black/90 outline-none" onClick={onClose}>
      <div className="flex items-center gap-3 p-3 text-sm text-[#fff]">
        <span className="flex-1">{format(new Date(c.created_at), "yyyy. M. d. (EEE) HH:mm 캡처", { locale: ko })}</span>
        <button className="rounded p-1 hover:bg-white/20" style={{ color: "#fff" }} title="닫기 (Esc)" aria-label="닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3" onClick={(e) => e.stopPropagation()}>
        <img
          src={imageUrl(c.id)}
          alt="원본 캡처"
          title={full ? "화면에 맞추기" : "원래 크기로"}
          onClick={() => setFull(!full)}
          className={cn("mx-auto", full ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
        />
      </div>
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
  return v ? <span className="ml-1 text-xs font-normal text-white/40">v{v}</span> : null;
}

// The mini view: a narrow portrait window kept above other windows. Leaving it restores the size it had.
// Both ways the right edge stays put, so the window grows and shrinks toward the left.
let fullSize: { width: number; height: number } | null = null;
async function setCompactWindow(on: boolean) {
  if (!tauri) return;
  const w = tauri.window.getCurrentWindow();
  const size = (width: number, height: number) => new tauri.window.LogicalSize(width, height);
  const [inner, scale, pos, monitor] = await Promise.all([w.innerSize(), w.scaleFactor(), w.outerPosition(), tauri.window.currentMonitor()]);
  const next = on ? { width: 260, height: 420 } : (fullSize ?? { width: 1100, height: 760 });
  if (on) fullSize = { width: inner.width / scale, height: inner.height / scale };
  await w.setMinSize(on ? size(200, 240) : size(400, 520));
  await w.setSize(size(next.width, next.height));
  const x = Math.max(monitor?.position.x ?? 0, pos.x + inner.width - Math.round(next.width * scale));
  await w.setPosition(new tauri.window.PhysicalPosition(x, pos.y));
  await w.setAlwaysOnTop(on);
}

function CompactView({ todos, onExpand }: { todos: Todo[]; onExpand: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header onMouseDown={dragWindow} className="flex h-8 shrink-0 select-none items-center gap-1 border-b border-white/[0.06] px-2">
        <h1 className="flex-1 truncate text-xs font-semibold">
          오늘 {format(startOfToday(), "M/d (EEE)", { locale: ko })}
          {todos.length > 0 && <span className="ml-1 rounded-full bg-orange-500 px-1.5 text-[10px] text-[#fff]">{todos.length}</span>}
        </h1>
        <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="크게 보기" onClick={onExpand}>
          <Maximize2 size={13} />
        </button>
        {tauri && (
          <button className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="최소화" onClick={() => tauri.window.getCurrentWindow().minimize()}>
            <Minus size={14} />
          </button>
        )}
      </header>
      {todos.length ? (
        <ul className="min-h-0 flex-1 divide-y divide-white/[0.04] overflow-y-auto p-1">{todos.map((t) => <TodoRow key={t.id} t={t} />)}</ul>
      ) : (
        <p className="p-3 text-xs text-white/40">오늘 할일을 다 끝냈습니다.</p>
      )}
    </div>
  );
}

const iconBtn = "rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white";
const toolBtn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.12] px-2.5 text-sm text-white/80 hover:bg-white/[0.06] hover:text-white";

function Section({ title, count, tone, children }: { title: string; count: number; tone?: "warn"; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.08] px-1.5 pb-2 pt-3">
      <h3 className={cn("flex items-center gap-1.5 px-1.5 text-sm font-semibold", tone === "warn" && count > 0 && "text-red-300 light:text-red-700")}>
        {tone === "warn" && count > 0 && <AlertTriangle size={14} aria-hidden />}
        {title}
        <span className="ml-auto text-xs font-normal tabular-nums text-white/50">{count}</span>
      </h3>
      {children}
    </section>
  );
}

type Scope = "now" | "day" | "week" | "month" | "nodue";

/** The list panel that used to sit beside the calendar: the 할 일 / 완료 / 통화 메모 tabs (reorderable), over a
 *  chosen span. Slides in from the right and is resizable by its left edge. */
function ListDrawer({
  state,
  tab,
  setTab,
  scope,
  setScope,
  selected,
  inSpan,
  onClose,
}: {
  state: State;
  tab: Tab;
  setTab: (t: Tab) => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  selected: Date;
  inSpan: (d: Date) => boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayer(onClose, ref);
  const [tabOrder, setTabOrder] = useState(readTabOrder);
  const [draggedTab, setDraggedTab] = useState<Tab | null>(null);
  const moveTab = (from: Tab, to: Tab) => {
    const next = tabOrder.filter((t) => t !== from);
    next.splice(tabOrder.indexOf(to), 0, from);
    setTabOrder(next);
    try {
      localStorage.setItem("tabOrder", JSON.stringify(next));
    } catch {}
  };
  const [width, setWidth] = useState(readSideWidth);
  const resize = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => setWidth(clampSide(window.innerWidth - m.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      setWidth((w) => {
        try {
          localStorage.setItem("sideWidth", String(w));
        } catch {}
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const open = state.todos.filter((t) => !t.done);
  const listed = (scope === "now" ? open : scope === "nodue" ? open.filter((t) => !t.due) : open.filter((t) => t.due && inSpan(dueDate(t.due)))).sort(byOrder);
  // Also under its due day: completing a todo while that day is picked must not make it vanish from both tabs.
  const doneTodos = state.todos
    .filter((t) => t.done && (scope === "nodue" ? !t.due : inSpan(doneDay(t)) || (scope !== "now" && !!t.due && inSpan(dueDate(t.due)))))
    .sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));
  const shown = tab === "todo" ? listed : doneTodos;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="목록"
      style={{ "--side": `${width}px` } as CSSProperties}
      className="absolute inset-y-0 right-0 z-30 flex w-[min(var(--side),100%)] flex-col border-l border-white/[0.1] bg-popup shadow-2xl outline-none"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        title="끌어서 목록 크기 조절 · 두 번 눌러 기본값"
        onPointerDown={resize}
        onDoubleClick={() => {
          setWidth(360);
          try {
            localStorage.removeItem("sideWidth");
          } catch {}
        }}
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-orange-500/40"
      />
      <div className="flex items-center gap-2 border-b border-white/[0.08] p-3">
        <h2 className="text-sm font-semibold">목록</h2>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="h-8 min-w-0 flex-1 rounded-md border border-white/[0.12] bg-surface px-2 text-sm text-white/85" title="목록에 보일 할일">
          <option value="now">현재 · 미완료 전체</option>
          <option value="day">{format(selected, "M/d (EEE)", { locale: ko })}</option>
          <option value="week">보고 있는 주</option>
          <option value="month">보고 있는 달</option>
          <option value="nodue">마감 없음</option>
        </select>
        <button className={iconBtn} title="닫기 (Esc)" aria-label="목록 닫기" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-1 border-b border-white/[0.08] px-3 pt-2">
        {tabOrder.map((k) => (
          <button
            key={k}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              setDraggedTab(k);
            }}
            onDragOver={(e) => draggedTab && draggedTab !== k && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedTab && draggedTab !== k) moveTab(draggedTab, k);
            }}
            onDragEnd={() => setDraggedTab(null)}
            className={cn(
              "-mb-px cursor-grab border-b-2 px-3 py-1.5 text-sm font-semibold active:cursor-grabbing",
              tab === k ? "border-orange-500 text-white" : "border-transparent text-white/50 hover:text-white/80",
              draggedTab === k && "opacity-40",
            )}
            onClick={() => setTab(k)}
            title={k === "done" && scope === "now" ? "오늘 완료한 할일 · 끌어서 순서 변경" : "끌어서 순서 변경"}
          >
            {k === "todo" ? `할 일 ${listed.length}` : k === "done" ? `완료 ${doneTodos.length}` : `통화 메모 ${state.calls?.length ?? 0}`}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "calls" ? (
          <CallNotes calls={state.calls ?? []} />
        ) : shown.length ? (
          <ul className="p-1.5">
            {shown.map((t) => (
              <TodoRow key={t.id} t={t} />
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-white/45">{tab === "todo" ? "남은 할일이 없습니다." : "완료한 할일이 없습니다."}</p>
        )}
      </div>
    </aside>
  );
}

/** Narrow windows: the side panel as an overlay, closed by Esc or a tap outside. Too short to pin the
 *  calendar and buttons, so here the whole panel scrolls. */
function SideOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(onClose, ref);
  return (
    <div className="absolute inset-0 z-30 bg-black/50 lg:hidden" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="side-panel h-full w-[min(300px,85%)] overflow-y-auto shadow-2xl outline-none" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<State>({ captures: [], todos: [] });
  const [msg, setMsgState] = useState("");
  setMsg = setMsgState;
  const [view, setView] = useState<"month" | "week">("month");
  // The day the main view is built around; month view shows its month, week view its Monday–Friday.
  const [cursor, setCursor] = useState(startOfToday);
  const [selected, setSelected] = useState(startOfToday);
  const [page, setPage] = useState<Page>("home");
  const [sideOpen, setSideOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<Tab>(() => readTabOrder()[0]);
  const [scope, setScope] = useState<Scope>("now");
  const openList = (t: Tab, s: Scope) => {
    setTab(t);
    setScope(s);
    setDrawer(true);
    setSideOpen(false);
  };
  // Keep the list where it is when the reopened todo belongs in it; otherwise widen to every open todo.
  showReopened = (due) => {
    setTab("todo");
    if (scope !== "now" && !(due && inSpan(dueDate(due)))) setScope("now");
  };
  const [compact, setCompact] = useState(false);
  const compactMode = (on: boolean) => {
    setCompact(on);
    setCompactWindow(on).catch((e) => setMsgState(`창 크기 변경 실패: ${e}`));
  };
  const [dayOpen, setDayOpen] = useState<Date | null>(null);
  const [staged, setStaged] = useState<Blob[] | null>(null);
  stage = setStaged;
  const [viewing, setViewing] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [capturesOpen, setCapturesOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<Date | null>(null);
  actions.open = setEditing;
  const [finishing, setFinishing] = useState<Todo | null>(null);
  finishTodo = setFinishing;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);

  // Evidence on hover: shown after a short rest so passing over rows does nothing, kept while the pointer
  // crosses into the card, dropped shortly after it leaves both.
  const [peek, setPeek] = useState<{ t: Todo; el: HTMLElement } | null>(null);
  const timers = useRef<{ show?: number; hide?: number }>({});
  const keep = () => {
    clearTimeout(timers.current.hide);
    timers.current.hide = undefined;
  };
  actions.hover = (t, el) => {
    keep();
    clearTimeout(timers.current.show);
    // A row can vanish under a resting pointer (its popup closed); it never gets a mouseleave then.
    timers.current.show = window.setTimeout(() => el.isConnected && setPeek({ t, el }), 400);
  };
  const hide = () => {
    timers.current.hide ??= window.setTimeout(() => {
      timers.current.hide = undefined;
      setPeek(null);
    }, 200);
  };
  actions.leave = () => {
    clearTimeout(timers.current.show);
    hide();
  };

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
    // Only file drags upload; dragging a tab to reorder must not.
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
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

  const pending = state.pending ?? [];
  const busy = !!(editing || adding || finishing || settingsOpen || staged || dayOpen || capturesOpen || viewing || enlarged || drawer || sideOpen);
  // New look-alikes open the check by themselves, unless the user is in the middle of another popup.
  const seenPending = useRef(0);
  useEffect(() => {
    if (pending.length > seenPending.current && !busy) setReviewOpen(true);
    seenPending.current = pending.length;
  }, [pending.length]);

  const byDay = useMemo(() => {
    const m = new Map<string, Todo[]>();
    for (const t of [...state.todos].sort(byOrder)) if (t.due) m.set(t.due, [...(m.get(t.due) ?? []), t]);
    return m;
  }, [state.todos]);

  const span = scope === "day" ? { start: selected, end: selected } : scope === "week" ? { start: startOfWeek(cursor, { weekStartsOn: 1 }), end: endOfWeek(cursor, { weekStartsOn: 1 }) } : scope === "month" ? { start: startOfMonth(cursor), end: endOfMonth(cursor) } : null;
  const inSpan = (d: Date) => (span ? isWithinInterval(d, { start: startOfDay(span.start), end: endOfDay(span.end) }) : isToday(d));
  const open = state.todos.filter((t) => !t.done);
  const today = format(startOfToday(), "yyyy-MM-dd");
  const todayTodos = state.todos.filter((t) => t.due === today).sort(byOrder);
  const overdue = state.todos.filter(isOverdue).sort(byOrder);
  const noDue = open.filter((t) => !t.due);
  const doneToday = state.todos.filter((t) => t.done && isToday(doneDay(t))).length;
  const edited = editing ? state.todos.find((t) => t.id === editing) : undefined;
  const view_ = viewing ? state.captures.find((c) => c.id === viewing) : undefined;
  const big = enlarged ? state.captures.find((c) => c.id === enlarged) : undefined;
  const liveCaptures = (t: Todo) => evidenceOf(t).filter((id) => state.captures.some((c) => c.id === id));

  const step = (n: number) => setCursor(view === "month" ? addMonths(startOfMonth(cursor), n) : addWeeks(cursor, n));
  const goToday = () => {
    setCursor(startOfToday());
    setSelected(startOfToday());
  };
  const pickDay = (d: Date) => {
    setPage("home");
    setCursor(d);
    setSelected(d);
    setSideOpen(false);
  };
  const showDay = (d: Date) => {
    setSelected(d);
    setDayOpen(d);
  };
  const week = workWeek(cursor);
  const period =
    view === "month"
      ? format(cursor, "yyyy년 M월")
      : isSameMonth(week[0], week[4])
        ? `${format(week[0], "yyyy년 M월 d일")} – ${format(week[4], "d일")}`
        : `${format(week[0], "yyyy년 M월 d일")} – ${format(week[4], "M월 d일")}`;

  const detail = edited && (
    <TodoDetail key={edited.id} todo={edited} captureIds={liveCaptures(edited)} onClose={() => setEditing(null)} onChanged={refresh} onReopen={showReopened} onFinish={setFinishing} onOpenCapture={setEnlarged} />
  );
  const confirmUpload = staged && <ConfirmUpload images={staged} onClose={() => setStaged(null)} />;
  const finish = finishing && <FinishTodo key={finishing.id} todo={finishing} captureIds={liveCaptures(finishing)} onClose={() => setFinishing(null)} onChanged={refresh} />;
  const evidence = peek && (
    <EvidenceCard
      todo={state.todos.find((t) => t.id === peek.t.id) ?? peek.t}
      source={peek.el}
      captures={state.captures}
      onKeep={keep}
      onLeave={hide}
      onClose={() => setPeek(null)}
      onOpenCapture={(id) => {
        setPeek(null);
        setEnlarged(id);
      }}
    />
  );
  const enlargedView = big && <ImageViewer c={big} onClose={() => setEnlarged(null)} />;

  if (compact)
    return (
      <div className="relative h-full">
        <CompactView todos={open.filter((t) => t.due && t.due <= today).sort(byOrder)} onExpand={() => compactMode(false)} />
        {detail}
        {confirmUpload}
        {finish}
        {enlargedView}
        {evidence}
      </div>
    );

  const menu = (rail: boolean) => (
    <nav aria-label="메뉴" className={rail ? "flex w-16 shrink-0 flex-col items-stretch gap-1 border-r border-white/[0.08] bg-side px-1.5 py-2" : "shrink-0 space-y-0.5 border-b border-white/[0.08] p-2"}>
      {(
        [
          ["홈", Home, page === "home", () => setPage("home")],
          ["목록", List, drawer, () => setDrawer(!drawer)],
          ["통계", BarChart3, page === "stats", () => setPage("stats")],
          ["주간업무", NotebookPen, page === "weekly", () => setPage("weekly")],
          ["환경설정", Gear, settingsOpen, () => setSettingsOpen(true)],
        ] as const
      ).map(([label, Icon, active, go]) => (
        <button
          key={label}
          type="button"
          aria-current={active && label !== "목록" && label !== "환경설정" ? "page" : undefined}
          aria-pressed={label === "목록" ? drawer : undefined}
          onClick={() => {
            go();
            setSideOpen(false);
          }}
          className={cn(
            "flex rounded-md",
            rail ? "flex-col items-center gap-1 py-2 text-[11px] leading-none" : "h-8 w-full items-center gap-2.5 px-2.5 text-sm",
            active ? "bg-orange-500/15 font-semibold text-orange-300 light:text-orange-700" : "text-white/70 hover:bg-white/[0.06] hover:text-white",
          )}
        >
          <Icon size={rail ? 18 : 16} aria-hidden />
          {label}
        </button>
      ))}
    </nav>
  );

  const side = (
    <>
      <div className="shrink-0 pb-3">
        <MiniCalendar anchor={view === "week" ? cursor : selected} byDay={byDay} onPick={pickDay} />
      </div>
      {/* Only the lists scroll; the calendar above and the buttons below stay put. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="기한 초과" count={overdue.length} tone="warn">
          {overdue.length ? (
            <ul className="mt-1">
              {overdue.map((t) => (
                <TodoRow key={t.id} t={t} />
              ))}
            </ul>
          ) : (
            <p className="px-1.5 pt-1 text-sm text-white/45">기한이 지난 할일이 없습니다.</p>
          )}
        </Section>
        <Section title={`오늘 할 일 · ${format(startOfToday(), "M/d (EEE)", { locale: ko })}`} count={todayTodos.filter((t) => !t.done).length}>
          {todayTodos.length ? (
            <ul className="mt-1">
              {todayTodos.map((t) => (
                <TodoRow key={t.id} t={t} />
              ))}
            </ul>
          ) : (
            <p className="px-1.5 pt-1 text-sm text-white/45">오늘 마감인 할일이 없습니다.</p>
          )}
        </Section>
      </div>
      <section className="grid shrink-0 grid-cols-2 gap-1.5 border-t border-white/[0.08] p-3 text-sm">
          {(
            [
              ["마감 없음", noDue.length, () => openList("todo", "nodue")],
              ["전체 할 일", open.length, () => openList("todo", "now")],
              ["오늘 완료", doneToday, () => openList("done", "now")],
              ["통화 메모", state.calls?.length ?? 0, () => openList("calls", "now")],
            ] as const
          ).map(([label, n, go]) => (
            <button key={label} type="button" onClick={go} className="flex items-center justify-between rounded-md border border-white/[0.12] px-2.5 py-1.5 text-left hover:bg-white/[0.06]">
              {label}
              <span className="tabular-nums text-white/55">{n}</span>
            </button>
          ))}
      </section>
    </>
  );

  return (
    <div className="relative flex h-full flex-col">
      <header onMouseDown={dragWindow} className="flex shrink-0 select-none flex-wrap items-center gap-2 border-b border-white/[0.08] px-3 py-2">
        <button className={cn(iconBtn, page === "home" ? "lg:hidden" : "md:hidden")} title="메뉴·달력·오늘 할 일 열기" aria-label="왼쪽 영역 열기" onClick={() => setSideOpen(true)}>
          <Menu size={18} />
        </button>
        <h1 className="mr-1 text-sm font-semibold">
          Aphendo
          <AppVersion />
          {open.length > 0 && <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 text-xs text-[#fff]">{open.length}</span>}
        </h1>
        {page === "home" ? (
        <>
        <div className="flex items-center">
          <button className={iconBtn} aria-label={view === "month" ? "이전 달" : "이전 주"} title={view === "month" ? "이전 달" : "이전 주"} onClick={() => step(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button className="rounded-md px-2 py-1 text-sm text-white/80 hover:bg-white/10" onClick={goToday}>
            오늘
          </button>
          <button className={iconBtn} aria-label={view === "month" ? "다음 달" : "다음 주"} title={view === "month" ? "다음 달" : "다음 주"} onClick={() => step(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
        <h2 className="text-base font-semibold tabular-nums">{period}</h2>
        <div role="group" aria-label="보기" className="flex rounded-md border border-white/[0.12] p-0.5">
          {(["month", "week"] as const).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              className={cn("rounded px-2.5 py-0.5 text-sm", view === v ? "bg-orange-500 font-medium text-[#fff]" : "text-white/70 hover:bg-white/10")}
              onClick={() => {
                if (v === "week" && isSameMonth(selected, cursor)) setCursor(selected);
                setView(v);
              }}
            >
              {v === "month" ? "월간" : "주간"}
            </button>
          ))}
        </div>
        </>
        ) : (
          <h2 className="text-base font-semibold">{page === "stats" ? "통계" : "주간업무"}</h2>
        )}
        <span className="flex-1" />
        {tauri && (
          <button className={cn(toolBtn, "border-orange-500/50 bg-orange-500 font-medium text-[#fff] hover:bg-orange-600 hover:text-[#fff]")} title="화면 캡처 (Alt+Shift+S)" onClick={() => tauri.core.invoke("start_snip").catch((e) => setMsgState(`화면 캡처 실패: ${e}`))}>
            <Camera size={15} />
            캡처
          </button>
        )}
        <button className={toolBtn} title="캡처 없이 할일 직접 추가" onClick={() => setAdding(selected)}>
          <Plus size={15} />
          <span className="max-sm:sr-only">할일</span>
        </button>
        <button className={toolBtn} title="캡처한 이미지 목록" onClick={() => setCapturesOpen(true)}>
          <Images size={15} />
          <span className="max-sm:sr-only">캡처 목록</span>
          <span className="tabular-nums text-white/50">{state.captures.length}</span>
        </button>
        {pending.length > 0 && (
          <button className={cn(toolBtn, "border-orange-500/60 text-orange-300 light:text-orange-700")} title="이미 있는 업무와 비슷해서 보류한 업무" onClick={() => setReviewOpen(true)}>
            <Copy size={15} />
            중복 확인 {pending.length}
          </button>
        )}
        <UpdateButton />
        <button className={iconBtn} title="오늘 할일만 작게 보기" aria-label="작게 보기" onClick={() => compactMode(true)}>
          <Shrink size={17} />
        </button>
        {tauri && (
          <button className={iconBtn} title="최소화" aria-label="최소화" onClick={() => tauri.window.getCurrentWindow().minimize()}>
            <Minus size={17} />
          </button>
        )}
        {tauri && (
          <button className={iconBtn} title="닫기" aria-label="창 닫기" onClick={() => tauri.window.getCurrentWindow().close()}>
            <X size={17} />
          </button>
        )}
      </header>
      {config && !configured(config) && (
        <button className="block w-full shrink-0 border-b border-white/[0.06] bg-orange-500/10 px-3 py-2 text-left text-sm text-orange-300 light:text-orange-700 hover:bg-orange-500/20" onClick={() => setSettingsOpen(true)}>
          접속 토큰이 없어 캡처를 분석할 수 없습니다. ⚙ 설정을 눌러 입력하세요.
        </button>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="side-panel hidden md:flex">{menu(true)}</div>
        {page === "home" && <aside className="side-panel hidden w-[280px] shrink-0 flex-col border-r border-white/[0.08] lg:flex">{side}</aside>}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {page === "weekly" ? (
            <WeeklyReport reports={state.reports} />
          ) : page === "stats" ? (
            <div className="mx-auto max-w-3xl space-y-8 p-6">
              <h1 className="text-xl font-semibold">통계</h1>
              <FollowUpTimeline todos={state.todos} />
              <p className="rounded-lg border border-dashed border-white/[0.15] p-6 text-sm text-white/55">그래프는 준비 중입니다. 완료 추이, 분류별 할일, 기한 준수율 같은 그래프가 들어올 자리입니다.</p>
            </div>
          ) : view === "month" ? (
            <MonthGrid month={cursor} byDay={byDay} selected={selected} onDay={showDay} />
          ) : (
            <WeekBoard anchor={cursor} byDay={byDay} onDay={showDay} />
          )}
        </main>
        {drawer && <ListDrawer state={state} tab={tab} setTab={setTab} scope={scope} setScope={setScope} selected={selected} inSpan={inSpan} onClose={() => setDrawer(false)} />}
      </div>

      {sideOpen && (
        <SideOverlay onClose={() => setSideOpen(false)}>
          <div className="md:hidden">{menu(false)}</div>
          {page === "home" && side}
        </SideOverlay>
      )}
      {capturesOpen && <CaptureList captures={state.captures} onView={setViewing} onClose={() => setCapturesOpen(false)} />}
      {view_ && <CaptureView c={view_} todos={state.todos.filter((t) => evidenceOf(t).includes(view_.id))} onClose={() => setViewing(null)} />}
      {dayOpen && (
        <DayTodos
          day={dayOpen}
          todos={state.todos.filter((t) => t.due === format(dayOpen, "yyyy-MM-dd")).sort(byOrder)}
          onAdd={() => {
            setDayOpen(null);
            setAdding(dayOpen);
          }}
          onClose={() => setDayOpen(null)}
        />
      )}
      {confirmUpload}
      {reviewOpen && <DuplicateReview pending={pending} todos={state.todos} captures={state.captures} onClose={() => setReviewOpen(false)} onChanged={refresh} onOpenCapture={setEnlarged} />}
      {adding && (
        <TodoDetail
          todo={{ id: "", capture_id: "", title: "", due: format(adding, "yyyy-MM-dd"), sender: null, method: null, contact: null, detail: null, done: false, done_at: null, done_note: null, priority: 0, repeat: null, created_at: "" }}
          captureIds={[]}
          onClose={() => setAdding(null)}
          onChanged={refresh}
          onReopen={showReopened}
        />
      )}
      {detail}
      {finish}
      {settingsOpen && <Settings config={config} theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)} onSaved={setConfig} />}
      {enlargedView}
      {evidence}
      {msg && (
        <div role="alert" className="absolute bottom-3 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-start gap-2 rounded-md border border-red-500/40 bg-popup px-3 py-2 text-sm text-red-300 shadow-xl light:text-red-700">
          <span className="break-words">{msg}</span>
          <button className="shrink-0 rounded p-0.5 hover:bg-white/10" aria-label="알림 닫기" onClick={() => setMsgState("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-md border-2 border-dashed border-orange-500/60 bg-orange-500/[0.06] text-sm text-orange-300 light:text-orange-700">
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
