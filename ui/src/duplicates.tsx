import { useRef, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { X } from "lucide-react";
import { API, imageUrl, type Capture } from "./api";
import { cn } from "@/lib/utils";
import { useLayer } from "./layer";
import type { Todo } from "./todo-detail";
import { dueDate, evidenceOf } from "./todo-item";

export type Pending = { id: string; todo: Todo; matches: { todo_id: string; reasons: string[] }[] };
type Resolve = { action: "keep" } | { action: "add" } | { action: "attach"; todo_id: string };

const due = (t: Todo) => (t.due ? format(dueDate(t.due), "yyyy. M. d. (EEE)", { locale: ko }) : "마감 없음");
const stars = (t: Todo) => (t.priority ? "★".repeat(t.priority) : "없음");

const ROWS: { label: string; show: (t: Todo) => string }[] = [
  { label: "제목", show: (t) => t.title },
  { label: "마감일", show: due },
  { label: "중요도", show: stars },
  { label: "발신자", show: (t) => t.sender ?? "" },
  { label: "제출방법", show: (t) => t.method ?? "" },
  { label: "비고", show: (t) => t.detail ?? "" },
];

function Source({ t, captures, onOpen }: { t: Todo; captures: Capture[]; onOpen: (id: string) => void }) {
  const shots = evidenceOf(t).filter((id) => captures.some((c) => c.id === id));
  if (!shots.length) return <span className="text-white/50">직접 입력 · 연결된 근거 없음</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {shots.map((id) => (
        <button key={id} type="button" title="원본 크게 보기" className="h-14 w-20 overflow-hidden rounded border border-white/[0.12] hover:border-orange-500/60" onClick={() => onOpen(id)}>
          <img src={imageUrl(id)} alt="근거 캡처" className="h-full w-full object-cover object-top" />
        </button>
      ))}
    </span>
  );
}

/** Each held todo next to the listed todo(s) it looks like, field by field with differences marked, and the
 *  three choices. Closing leaves everything held; the header button brings this back. */
export function DuplicateReview({
  pending,
  todos,
  captures,
  onClose,
  onChanged,
  onOpenCapture,
}: {
  pending: Pending[];
  todos: Todo[];
  captures: Capture[];
  onClose: () => void;
  onChanged: () => void;
  onOpenCapture: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer(onClose, ref);
  const [error, setError] = useState("");

  async function resolve(id: string, r: Resolve) {
    const res = await fetch(`${API}/api/pending/${id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) }).catch(() => null);
    setError(res?.ok ? "" : res ? await res.text() : "로컬 서버에 연결할 수 없습니다.");
    onChanged();
  }

  const btn = "rounded-md px-3 py-1.5 text-sm font-medium";
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-4" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-label="중복 의심 업무 확인" className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-popup shadow-2xl outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b border-white/[0.08] px-4 py-3">
          <div className="flex-1">
            <h2 className="text-base font-semibold">중복 의심 업무 {pending.length}건</h2>
            <p className="text-sm text-white/55">이미 있는 업무와 비슷해 보여서 바로 추가하지 않았습니다. 하나씩 골라 주세요. 닫아도 남아 있습니다.</p>
          </div>
          <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기 (나중에 확인)" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {error && <p className="px-4 pt-2 text-sm text-red-300 light:text-red-700">{error}</p>}
        <div className="space-y-4 overflow-y-auto p-4">
          {pending.length === 0 && <p className="text-sm text-white/55">확인할 업무가 없습니다.</p>}
          {pending.map((p) => {
            const hasShot = evidenceOf(p.todo).length > 0;
            return (
              <section key={p.id} className="rounded-lg border border-white/[0.1] bg-surface">
                {p.matches.map((m) => {
                  const old = todos.find((t) => t.id === m.todo_id);
                  if (!old) return null;
                  const linked = evidenceOf(old).includes(p.todo.capture_id);
                  return (
                    <div key={m.todo_id} className="border-b border-white/[0.08] p-3 last:border-b-0">
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {m.reasons.map((r) => (
                          <span key={r} className="rounded bg-orange-500/15 px-1.5 py-0.5 text-xs font-medium text-orange-300 light:text-orange-700">
                            {r}
                          </span>
                        ))}
                      </div>
                      <table className="w-full table-fixed text-sm">
                        <thead>
                          <tr className="text-left text-xs text-white/50">
                            <th className="w-20 pb-1 font-medium">항목</th>
                            <th className="pb-1 font-medium">새로 들어온 업무</th>
                            <th className="pb-1 font-medium">이미 있는 업무 {old.done ? "· 완료됨" : "· 진행 중"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ROWS.map(({ label, show }) => {
                            const [a, b] = [show(p.todo), show(old)];
                            if (!a && !b) return null;
                            const diff = a !== b;
                            return (
                              <tr key={label} className="align-top">
                                <td className="py-1 pr-2 text-xs text-white/50">
                                  {label}
                                  {diff && <span className="ml-1 rounded bg-white/10 px-1 text-[11px] font-semibold text-white/80">다름</span>}
                                </td>
                                <Cell diff={diff}>{a || "—"}</Cell>
                                <Cell diff={diff}>{b || "—"}</Cell>
                              </tr>
                            );
                          })}
                          <tr className="align-top">
                            <td className="py-1 pr-2 text-xs text-white/50">근거</td>
                            <td className="py-1 pr-2">
                              <Source t={p.todo} captures={captures} onOpen={onOpenCapture} />
                            </td>
                            <td className="py-1">
                              <Source t={old} captures={captures} onOpen={onOpenCapture} />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          disabled={!hasShot || linked}
                          title={!hasShot ? "새 업무에 캡처가 없어 연결할 근거가 없습니다" : linked ? "이미 연결된 캡처입니다" : "제목·마감·완료 상태는 그대로 두고 캡처만 근거로 붙입니다"}
                          className={cn(btn, "border border-white/[0.15] hover:bg-white/10 disabled:opacity-40")}
                          onClick={() => resolve(p.id, { action: "attach", todo_id: old.id })}
                        >
                          이 업무에 근거 추가
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.08] bg-white/[0.02] p-3">
                  <button type="button" className={cn(btn, "border border-white/[0.15] hover:bg-white/10")} onClick={() => resolve(p.id, { action: "keep" })} title="새 업무를 만들지 않습니다">
                    기존 업무 유지
                  </button>
                  <button type="button" className={cn(btn, "bg-orange-500 text-[#fff] hover:bg-orange-600")} onClick={() => resolve(p.id, { action: "add" })} title="서로 다른 업무로 저장합니다">
                    별도 업무로 추가
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const Cell = ({ diff, children }: { diff: boolean; children: ReactNode }) => (
  <td className={cn("whitespace-pre-wrap break-words py-1 pr-2", diff ? "font-medium text-white" : "text-white/75")}>{children}</td>
);
