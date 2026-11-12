import { useEffect, useRef, useState, type ReactNode } from "react";
import { addDays, format, isValid, parse, startOfToday, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight, Copy, Plus, Sparkles, X } from "lucide-react";
import { API } from "./api";
import { cn } from "@/lib/utils";

export type Report = { start: string; end: string; planned_start: string; planned_end: string; done: string[]; planned: string[] };
type Item = { title: string; note?: string; due?: string };
type Box = "done" | "planned";
const BOX: Record<Box, { title: string; empty: string; source: string }> = {
  done: { title: "실시항목", empty: "이 기간에 완료한 할일이 있으면 AI 초안으로 채웁니다.", source: "기간 안에 완료한 할일" },
  planned: { title: "예정항목", empty: "남은 할일이 있으면 AI 초안으로 채웁니다.", source: "예정 끝 날짜까지 마감인 미완료 할일 (기한 초과 포함)" },
};

const shown = (d: Date) => format(d, "yyyy.MM.dd");
const iso = (d: Date) => format(d, "yyyy-MM-dd");
/** "2026.10.06", "2026-10-6", "2026/10/06" all read as the same day. */
function readDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?$/);
  if (!m) return null;
  const d = parse(`${m[1]}-${m[2]}-${m[3]}`, "yyyy-M-d", new Date());
  return isValid(d) ? d : null;
}

/** A sentence line that grows with its text. Enter starts the next line, Backspace on an empty line removes it. */
function Line({ value, onChange, onEnter, onRemove }: { value: string; onChange: (v: string) => void; onEnter: () => void; onRemove: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <li className="group flex items-start gap-2 rounded-md px-1 hover:bg-white/[0.03] focus-within:bg-white/[0.04]">
      <span className="pt-[7px] text-white/40" aria-hidden>
        ·
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        aria-label="문장"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Backspace" && !value) {
            e.preventDefault();
            onRemove();
          }
        }}
        className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1 text-[15px] leading-[1.6] text-white/90 outline-none"
      />
      <button type="button" className="mt-1 rounded p-1 text-white/30 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100" aria-label="문장 삭제" title="삭제" onClick={onRemove}>
        <X size={14} />
      </button>
    </li>
  );
}

type Span = { start: string; end: string };
const spanOf = (from: Date): Span => ({ start: shown(from), end: shown(addDays(from, 4)) });
/** The span as YYYY-MM-DD, or null while either day is unreadable or the end comes first. */
function readSpan(s: Span) {
  const [a, b] = [readDate(s.start), readDate(s.end)];
  return a && b && b >= a ? { start: iso(a), end: iso(b) } : null;
}

function SpanInputs({ box, span, onChange }: { box: Box; span: Span; onChange: (s: Span) => void }) {
  const [a, b] = [readDate(span.start), readDate(span.end)];
  const field = (bad: boolean) => cn("h-8 w-[7.5rem] rounded-md border bg-background px-2 text-center text-sm tabular-nums outline-none focus:border-orange-500/70", bad ? "border-red-500/70" : "border-white/[0.15]");
  return (
    <div className="flex items-center gap-1.5">
      <input aria-label={`${BOX[box].title} 시작 날짜`} className={field(!a)} value={span.start} placeholder="2026.10.06" onChange={(e) => onChange({ ...span, start: e.target.value })} />
      <span className="text-white/50">~</span>
      <input aria-label={`${BOX[box].title} 끝 날짜`} className={field(!b || (!!a && b < a))} value={span.end} placeholder="2026.10.09" onChange={(e) => onChange({ ...span, end: e.target.value })} />
    </div>
  );
}

function SentenceBox({ box, dates, lines, sources, onChange }: { box: Box; dates: ReactNode; lines: string[]; sources: Item[]; onChange: (l: string[]) => void }) {
  // A fresh object per request, so asking for the same line twice still moves the caret.
  const [focusAt, setFocusAt] = useState<{ i: number } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusAt) list.current?.querySelectorAll("textarea")[focusAt.i]?.focus();
  }, [focusAt]);
  const [copied, setCopied] = useState(false);
  const set = (i: number, v: string) => onChange(lines.map((l, j) => (j === i ? v : l)));
  const insert = (i: number) => {
    onChange([...lines.slice(0, i), "", ...lines.slice(i)]);
    setFocusAt({ i });
  };
  const remove = (i: number) => {
    onChange(lines.filter((_, j) => j !== i));
    setFocusAt({ i: Math.max(0, i - 1) });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(lines.filter((l) => l.trim()).map((l) => `· ${l.trim()}`).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-white/[0.1] bg-surface" aria-label={BOX[box].title}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.08] px-4 py-2.5">
        <h2 className="text-base font-semibold">
          {BOX[box].title} <span className="text-sm font-normal tabular-nums text-white/50">{lines.filter((l) => l.trim()).length}</span>
        </h2>
        {dates}
        <span className="flex-1" />
        <button type="button" disabled={!lines.some((l) => l.trim())} onClick={copy} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/70 hover:bg-white/10 disabled:opacity-40" title="한 줄에 한 문장씩 복사">
          <Copy size={14} aria-hidden />
          {copied ? "복사됨" : "복사"}
        </button>
      </header>
      <div className="flex-1 p-2">
        {lines.length ? (
          <ul ref={list}>
            {lines.map((l, i) => (
              <Line key={i} value={l} onChange={(v) => set(i, v)} onEnter={() => insert(i + 1)} onRemove={() => remove(i)} />
            ))}
          </ul>
        ) : (
          <p className="px-2 py-3 text-sm text-white/45">{BOX[box].empty}</p>
        )}
        <button type="button" onClick={() => insert(lines.length)} className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/60 hover:bg-white/10 hover:text-white">
          <Plus size={14} aria-hidden />
          문장 추가
        </button>
      </div>
      <details className="border-t border-white/[0.08] px-4 py-2 text-sm text-white/60">
        <summary className="cursor-pointer select-none">
          바탕 할일 {sources.length}건 · {BOX[box].source}
        </summary>
        <ul className="mt-1.5 space-y-1">
          {sources.map((s, i) => (
            <li key={i} className="break-words">
              {s.title}
              {s.due && <span className="text-white/45"> · 마감 {format(parse(s.due, "yyyy-MM-dd", new Date()), "M/d")}</span>}
              {s.note && <span className="text-white/45"> · {s.note}</span>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** 주간업무일지: pick the period, let the AI draft one sentence per todo into 실시항목 and 예정항목, then fix
 *  the wording in place. What is in the boxes is saved for that period as the user edits. */
export function WeeklyReport({ reports }: { reports?: Report[] }) {
  const monday = startOfWeek(startOfToday(), { weekStartsOn: 1 });
  const [spans, setSpans] = useState<Record<Box, Span>>({ done: spanOf(monday), planned: spanOf(addDays(monday, 7)) });
  const [done, planned] = [readSpan(spans.done), readSpan(spans.planned)];
  const period = done && planned ? { ...done, planned_start: planned.start, planned_end: planned.end } : null;
  // A report is the 실시 period's; the 예정 span is part of it.
  const key = done ? `${done.start}~${done.end}` : "";

  const [boxes, setBoxes] = useState<Record<Box, string[]>>({ done: [], planned: [] });
  const [sources, setSources] = useState<Record<Box, Item[]>>({ done: [], planned: [] });
  const [status, setStatus] = useState<{ kind: "idle" | "drafting" | "saving" | "saved" } | { kind: "error"; text: string }>({ kind: "idle" });
  const [askOverwrite, setAskOverwrite] = useState(false);
  const dirty = useRef(false);

  // A new period loads what was kept for it; polling updates must not undo typing in progress.
  const loaded = useRef("");
  useEffect(() => {
    // Until the first state arrives there is nothing to load yet, not an empty report.
    if (!done || !reports || loaded.current === key) return;
    const saved = reports.find((r) => r.start === done.start && r.end === done.end);
    setBoxes({ done: saved?.done ?? [], planned: saved?.planned ?? [] });
    if (saved) setSpans((x) => ({ ...x, planned: { start: shown(parse(saved.planned_start, "yyyy-MM-dd", new Date())), end: shown(parse(saved.planned_end, "yyyy-MM-dd", new Date())) } }));
    loaded.current = key;
    dirty.current = false;
    setAskOverwrite(false);
  }, [key, reports]);

  useEffect(() => {
    if (!period) return;
    fetch(`${API}/api/reports/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(period) })
      .then((r) => (r.ok ? r.json() : { done: [], planned: [] }))
      .then(setSources, () => {});
  }, [period?.start, period?.end, period?.planned_end]);

  // Save shortly after the last edit, or after the 예정 span of a report with sentences changes.
  useEffect(() => {
    if (!period || !dirty.current) return;
    setStatus({ kind: "saving" });
    const t = setTimeout(async () => {
      const r = await fetch(`${API}/api/reports`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...period, ...boxes }) }).catch(() => null);
      setStatus(r?.ok ? { kind: "saved" } : { kind: "error", text: r ? await r.text() : "로컬 서버에 연결할 수 없습니다." });
    }, 600);
    return () => clearTimeout(t);
  }, [boxes, period?.planned_start, period?.planned_end]);

  const edit = (b: Box, lines: string[]) => {
    dirty.current = true;
    setBoxes((x) => ({ ...x, [b]: lines }));
  };

  async function draft() {
    if (!period) return;
    setAskOverwrite(false);
    setStatus({ kind: "drafting" });
    const r = await fetch(`${API}/api/reports/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(period) }).catch(() => null);
    if (!r?.ok) return setStatus({ kind: "error", text: r ? await r.text() : "로컬 서버에 연결할 수 없습니다." });
    const d: { done: string[]; planned: string[] } = await r.json();
    dirty.current = true;
    setBoxes({ done: d.done, planned: d.planned });
  }

  const hasText = boxes.done.some((l) => l.trim()) || boxes.planned.some((l) => l.trim());
  // Both spans move together by whole weeks.
  const shift = (days: number) =>
    setSpans((x) => {
      const move = (s: Span) => {
        const [a, b] = [readDate(s.start), readDate(s.end)];
        return a && b ? { start: shown(addDays(a, days)), end: shown(addDays(b, days)) } : s;
      };
      return { done: move(x.done), planned: move(x.planned) };
    });
  const btn = "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm";
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">주간업무일지</h1>
        <p className="mt-1 text-sm text-white/55">기간을 정하고 AI 초안을 만든 뒤, 문장을 눌러 바로 고칩니다. 고친 내용은 기간별로 자동 저장됩니다.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-md border border-white/[0.12]">
          <button type="button" className={cn(btn, "px-2 text-white/70 hover:bg-white/10")} aria-label="이전 주" title="실시·예정 기간을 한 주 앞으로" onClick={() => shift(-7)}>
            <ChevronLeft size={18} />
          </button>
          <span className="px-1 text-sm text-white/70">주 이동</span>
          <button type="button" className={cn(btn, "px-2 text-white/70 hover:bg-white/10")} aria-label="다음 주" title="실시·예정 기간을 한 주 뒤로" onClick={() => shift(7)}>
            <ChevronRight size={18} />
          </button>
        </div>
        <span className="flex-1" />
        <span role="status" className={cn("text-sm", status.kind === "error" ? "text-red-300 light:text-red-700" : "text-white/50")}>
          {status.kind === "drafting" ? "AI가 초안을 쓰는 중입니다. 1분 안팎 걸립니다." : status.kind === "saving" ? "저장 중…" : status.kind === "saved" ? "저장됨" : status.kind === "error" ? status.text : ""}
        </span>
        <button
          type="button"
          disabled={!period || status.kind === "drafting" || sources.done.length + sources.planned.length === 0}
          onClick={() => (hasText ? setAskOverwrite(true) : draft())}
          className={cn(btn, "bg-orange-500 font-medium text-[#fff] hover:bg-orange-600 disabled:opacity-40")}
          title={sources.done.length + sources.planned.length === 0 ? "이 기간에 바탕이 될 할일이 없습니다" : "실시·예정 할일로 문장 초안을 만듭니다"}
        >
          <Sparkles size={15} aria-hidden />
          {status.kind === "drafting" ? "작성 중…" : "AI 초안 만들기"}
        </button>
      </div>
      {!period && <p className="text-sm text-red-300 light:text-red-700">날짜를 2026.10.06 형식으로 쓰고, 끝 날짜는 시작 날짜와 같거나 뒤여야 합니다.</p>}
      {askOverwrite && (
        <div role="alertdialog" aria-label="초안으로 바꾸기" className="flex flex-wrap items-center gap-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm">
          <span className="flex-1">지금 박스의 문장을 새 초안으로 바꿉니다. 고친 문장도 사라집니다.</span>
          <button type="button" className="rounded-sm border border-white/[0.15] px-2.5 py-1 hover:bg-white/10" onClick={() => setAskOverwrite(false)}>
            그대로 두기
          </button>
          <button type="button" className="rounded-sm bg-orange-500 px-2.5 py-1 font-medium text-[#fff] hover:bg-orange-600" onClick={draft}>
            초안으로 바꾸기
          </button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {(["done", "planned"] as const).map((b) => (
          <SentenceBox
            key={b}
            box={b}
            dates={<SpanInputs box={b} span={spans[b]} onChange={(sp) => setSpans((x) => ({ ...x, [b]: sp }))} />}
            lines={boxes[b]}
            sources={sources[b]}
            onChange={(l) => edit(b, l)}
          />
        ))}
      </div>
    </div>
  );
}
