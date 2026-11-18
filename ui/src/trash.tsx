import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArchiveRestore, Search, Trash2, X } from "lucide-react";
import { useLayer } from "./layer";
import type { TrashItem } from "./api";

type TrashKind = TrashItem["kind"];

const KIND: Record<TrashKind, string> = { todo: "할 일", capture: "캡처 · 근거 자료", call: "통화 메모" };
const button = "inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.15] px-3 py-2 text-sm hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40";

function deletedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function keepFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.key !== "Tab") return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function PurgeConfirmation({ items, emptying, busy, error, onCancel, onConfirm }: {
  items: TrashItem[];
  emptying: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(() => { if (!busy) onCancel(); }, ref);
  const hasTodo = items.some((item) => item.kind === "todo");
  const hasCapture = items.some((item) => item.kind === "capture");
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { if (!busy) onCancel(); }}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="trash-confirm-title" aria-describedby="trash-confirm-description" tabIndex={-1}
        className="flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-lg border border-white/[0.15] bg-popup shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()} onKeyDown={keepFocus}>
        <div className="p-5 pb-3">
          <h3 id="trash-confirm-title" className="text-base font-semibold">{emptying ? "휴지통을 비울까요?" : "선택한 항목을 영구 삭제할까요?"}</h3>
          <p id="trash-confirm-description" className="mt-2 text-sm leading-relaxed text-white/75">아래 {items.length}개 항목은 복구할 수 없게 됩니다. 제목과 삭제 범위를 확인해 주세요.</p>
        </div>
        <ul className="mx-5 max-h-52 space-y-2 overflow-y-auto rounded-md border border-white/[0.1] bg-background p-3 text-sm">
          {items.map((item) => <li key={item.id} className="break-words"><span className="mr-2 text-xs text-white/55">{KIND[item.kind]}</span>{item.title || "이름 없는 항목"}
            {item.related_count > 0 && <span className="ml-2 text-xs text-white/55">{item.kind === "capture" ? `연결된 업무 ${item.related_count}개` : `연결된 근거 ${item.related_count}개`}</span>}
          </li>)}
        </ul>
        <div className="space-y-2 px-5 pt-3 text-sm leading-relaxed text-white/70">
          {hasTodo && <p>선택한 업무의 내용과 완료 메모, 삭제·복구 기록이 함께 제거됩니다. 업무에 연결된 캡처는 별도로 보관됩니다.</p>}
          {hasCapture && <p>선택한 캡처의 이미지도 삭제 대상입니다. 다른 업무에서 사용하는 캡처가 있으면 이번 선택 전체를 삭제하지 않습니다. 해당 캡처를 선택에서 제외해 주세요.</p>}
          <p>선택하지 않은 업무와 통화 메모는 유지됩니다.</p>
          {error && <p role="alert" className="text-red-300 light:text-red-700">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" data-autofocus className={button} disabled={busy} onClick={onCancel}>취소</button>
          <button type="button" className={`${button} border-red-500/40 text-red-300 hover:bg-red-500/10 light:text-red-700`} disabled={busy} onClick={onConfirm}>{busy ? "삭제 중…" : "영구 삭제"}</button>
        </div>
      </div>
    </div>
  );
}

/** Kept separate from the normal lists so deleted work cannot be completed or scheduled here. */
export function Trash({ items, onRestore, onPurge, onClose }: {
  items: TrashItem[];
  onRestore: (ids: string[]) => Promise<void>;
  onPurge: (ids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TrashKind | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ items: TrashItem[]; emptying: boolean } | null>(null);
  useLayer(() => { if (!busy) onClose(); }, ref);

  useEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
  }, [items]);

  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("ko-KR");
    return items.filter((item) => (kind === "all" || item.kind === kind) && item.title.toLocaleLowerCase("ko-KR").includes(search))
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  }, [items, kind, query]);
  const picked = items.filter((item) => selected.has(item.id));
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.has(item.id));
  const hiddenSelected = picked.length - visible.filter((item) => selected.has(item.id)).length;

  function choose(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function restore(targets: TrashItem[]) {
    if (!targets.length || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await onRestore(targets.map((item) => item.id));
      setSelected(new Set());
      setNotice("복구했습니다. 원래 날짜와 완료 상태가 유지됩니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "복구하지 못했습니다. 다시 시도해 주세요.");
    } finally { setBusy(false); }
  }

  function askPurge(targets: TrashItem[], emptying = false) {
    if (!targets.length || busy) return;
    setError(""); setNotice("");
    setConfirmation({ items: targets, emptying });
  }

  async function purge() {
    if (!confirmation || busy) return;
    setBusy(true); setError("");
    try {
      await onPurge(confirmation.items.map((item) => item.id));
      setSelected(new Set()); setConfirmation(null);
      setNotice("영구 삭제했습니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "영구 삭제하지 못했습니다. 다시 시도해 주세요.");
    } finally { setBusy(false); }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-3 sm:p-5" onClick={() => { if (!busy) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="trash-title" tabIndex={-1} aria-busy={busy}
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-popup shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()} onKeyDown={keepFocus}>
        <header className="flex items-start gap-3 border-b border-white/[0.08] px-5 py-4">
          <Trash2 size={20} className="mt-0.5 shrink-0 text-white/60" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="trash-title" className="text-lg font-semibold">휴지통 <span className="ml-1 text-sm font-normal text-white/55">{items.length}개</span></h2>
            <p className="mt-1 text-sm leading-relaxed text-white/65">삭제한 업무와 자료를 복구할 수 있습니다. 직접 영구 삭제하기 전까지 보관됩니다.</p>
          </div>
          <button type="button" disabled={busy} className="rounded p-1 text-white/60 hover:bg-white/10 disabled:opacity-40" title="닫기 (Esc)" aria-label="휴지통 닫기" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="space-y-3 border-b border-white/[0.08] px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <label className="flex min-w-40 flex-1 items-center gap-2 rounded-md border border-white/[0.15] bg-background px-3 focus-within:border-orange-500">
              <Search size={16} className="shrink-0 text-white/50" aria-hidden />
              <input data-autofocus type="search" aria-label="휴지통 제목 검색" placeholder="제목으로 검색" value={query} disabled={busy}
                onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-white/45" />
            </label>
            <select aria-label="항목 종류" value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as TrashKind | "all")}
              className="rounded-md border border-white/[0.15] bg-background px-3 py-2 text-sm outline-none focus:border-orange-500">
              <option value="all">모든 종류</option>
              {Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="mr-auto inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allVisibleSelected} disabled={busy || !visible.length} aria-label="검색 결과 모두 선택"
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((previous) => {
                    const next = new Set(previous);
                    for (const item of visible) { if (checked) next.add(item.id); else next.delete(item.id); }
                    return next;
                  });
                }} className="h-4 w-4 accent-orange-500" />
              {picked.length ? `${picked.length}개 선택` : `검색 결과 ${visible.length}개`}
            </label>
            <button type="button" className={button} disabled={busy || !picked.length} onClick={() => restore(picked)}><ArchiveRestore size={15} aria-hidden />선택 복구</button>
            <button type="button" className={`${button} text-red-300 light:text-red-700`} disabled={busy || !picked.length} onClick={() => askPurge(picked)}>선택 영구 삭제</button>
          </div>
          {hiddenSelected > 0 && <p className="text-xs text-white/65">현재 검색 결과 밖의 {hiddenSelected}개도 선택되어 있습니다. <button type="button" className="underline underline-offset-2" disabled={busy} onClick={() => setSelected(new Set())}>선택 모두 해제</button></p>}
        </div>

        <div className="min-h-28 overflow-y-auto px-5" aria-label="삭제 항목 목록">
          {error && !confirmation && <p role="alert" className="py-3 text-sm text-red-300 light:text-red-700">{error}</p>}
          {notice && <p role="status" className="py-3 text-sm text-white/80">{notice}</p>}
          {visible.length === 0 ? <p className="py-12 text-center text-sm text-white/60">{items.length ? "검색 조건에 맞는 항목이 없습니다." : "휴지통이 비어 있습니다."}</p> : (
            <ul className="divide-y divide-white/[0.08]">
              {visible.map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-4">
                  <input type="checkbox" aria-label={`${item.title || "이름 없는 항목"} 선택`} checked={selected.has(item.id)} disabled={busy}
                    onChange={(event) => choose(item.id, event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-orange-500" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium leading-relaxed">{item.title || "이름 없는 항목"}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-relaxed text-white/60">
                      <span>{KIND[item.kind]}</span>
                      <time dateTime={item.deleted_at}>{deletedAt(item.deleted_at)} 삭제</time>
                      {item.original_location && <span>원래 위치: {item.original_location}</span>}
                    </div>
                    {item.kind === "todo" && <p className="mt-1.5 text-xs leading-relaxed text-white/65">업무 내용·완료 메모 보관{item.related_count > 0 ? ` · 연결된 근거 ${item.related_count}개` : ""}</p>}
                    {item.kind === "capture" && item.related_count > 0 && <p className="mt-1.5 text-xs leading-relaxed text-white/65">연결된 업무 {item.related_count}개는 유지됩니다.</p>}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                    <button type="button" className={button} disabled={busy} aria-label={`${item.title || "항목"} 복구`} onClick={() => restore([item])}>복구</button>
                    <button type="button" className="rounded-md p-2 text-white/50 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40 light:hover:text-red-700" disabled={busy}
                      title="영구 삭제" aria-label={`${item.title || "항목"} 영구 삭제`} onClick={() => askPurge([item])}><Trash2 size={16} aria-hidden /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] px-5 py-3">
          <p className="text-xs leading-relaxed text-white/55">복구해도 원래 마감일과 완료 여부는 바뀌지 않습니다.</p>
          <button type="button" className={`${button} text-red-300 light:text-red-700`} disabled={busy || !items.length} onClick={() => askPurge(items, true)}>휴지통 비우기</button>
        </footer>
        {confirmation && <PurgeConfirmation items={confirmation.items} emptying={confirmation.emptying} busy={busy} error={error} onCancel={() => { setConfirmation(null); setError(""); }} onConfirm={purge} />}
      </div>
    </div>
  );
}
