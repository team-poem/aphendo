import { useEffect, useState } from "react";
import { format } from "date-fns";
import { X } from "lucide-react";
import { API } from "./api";
import { cn } from "@/lib/utils";

export type Todo = {
  id: string;
  capture_id: string;
  title: string;
  due: string | null;
  sender: string | null;
  method: string | null;
  contact: string | null;
  detail: string | null;
  done: boolean;
  done_at: string | null;
  done_note: string | null;
  priority: number;
  repeat: Repeat | null;
  created_at: string;
};
export type Repeat = "weekly" | "monthly";
export const REPEAT_LABEL: Record<Repeat, string> = { weekly: "매주", monthly: "매월" };

type Text = "title" | "sender" | "method" | "contact" | "detail";
const FIELDS: { key: Text; label: string; long?: boolean }[] = [
  { key: "sender", label: "발신자 (업무지시자)" },
  { key: "title", label: "제출내용 (업무내용)", long: true },
  { key: "method", label: "제출방법 (보고방법)", long: true },
  { key: "contact", label: "담당자 (문의처)" },
  { key: "detail", label: "비고", long: true },
];

/** Shows what the extractor read next to the capture so the user can check and correct every field.
 *  A todo with an empty id is a new one the user is typing in, with no capture behind it. */
export function TodoDetail({
  todo,
  imageUrl,
  onClose,
  onChanged,
  onReopen,
  onFinish,
}: {
  todo: Todo;
  imageUrl: string | null;
  onClose: () => void;
  onChanged: () => void;
  onReopen: (due: string | null) => void;
  /** Checking 완료 saves the edits and hands over to the completion dialog. */
  onFinish?: (t: Todo) => void;
}) {
  const [form, setForm] = useState(() => ({ ...todo, due: todo.due ?? "" }));
  const [zoom, setZoom] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const isNew = !todo.id;
  async function send(init: RequestInit) {
    const r = await fetch(`${API}/api/todos${isNew ? "" : `/${todo.id}`}`, init).catch(() => null);
    onChanged();
    if (r?.ok) {
      if (todo.done && !form.done) onReopen(form.due || null);
      onClose();
      return true;
    }
    setError(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
    return false;
  }

  const save = (withDone = !isNew) =>
    send({
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        due: form.due || null,
        sender: form.sender ?? "",
        method: form.method ?? "",
        contact: form.contact ?? "",
        detail: form.detail ?? "",
        priority: form.priority,
        repeat: form.repeat,
        ...(withDone && { done: form.done }),
      }),
    });

  const input = "mt-1 w-full rounded-sm border border-white/[0.1] bg-white/[0.03] px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500/60";
  const btn = "rounded-sm px-3 py-1.5 text-sm";
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-label="할일 상세"
        className={cn("flex w-full flex-col overflow-hidden rounded-md border border-white/[0.08] bg-background shadow-2xl", imageUrl ? "max-w-4xl" : "max-w-md")}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-center border-b border-white/[0.06] px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold">{isNew ? "할일 추가" : imageUrl ? "할일 상세 · 캡처와 비교해 고쳐 주세요" : "할일 상세"}</h2>
          <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row">
          {imageUrl && (
            <div className="max-h-[70vh] overflow-auto border-white/[0.06] bg-white/[0.02] p-3 md:w-1/2 md:border-r">
              <img
                src={imageUrl}
                alt="원본 캡처"
                title={zoom ? "축소" : "확대"}
                onClick={() => setZoom(!zoom)}
                className={cn(zoom ? "max-w-none cursor-zoom-out" : "w-full cursor-zoom-in")}
              />
            </div>
          )}

          <div className={cn("space-y-3 p-4", imageUrl && "md:w-1/2")}>
            {FIELDS.map(({ key, label, long }) => (
              <label key={key} className="block text-xs text-white/50">
                {label}
                {long ? (
                  <textarea
                    rows={2}
                    className={cn(input, "resize-y")}
                    required={key === "title"}
                    value={form[key] ?? ""}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                ) : (
                  <input className={input} value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                )}
              </label>
            ))}

            <label className="block text-xs text-white/50">
              제출기한 (마감일자)
              <div className="flex gap-2">
                <input type="date" className={input} value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
                {form.due && (
                  <button type="button" className={cn(btn, "mt-1 shrink-0 border border-white/[0.1] text-xs text-white/60 hover:bg-white/10")} onClick={() => setForm({ ...form, due: "" })}>
                    마감 없음
                  </button>
                )}
              </div>
            </label>

            <label className="block text-xs text-white/50">
              반복
              <select
                className={input}
                value={form.repeat ?? ""}
                onChange={(e) => setForm({ ...form, repeat: (e.target.value || null) as Repeat | null })}
                title="완료하면 다음 주·다음 달 같은 날짜로 새 할일이 생깁니다"
              >
                <option value="">반복 안 함</option>
                <option value="weekly">매주 (완료하면 다음 주 할일 생성)</option>
                <option value="monthly">매월 (완료하면 다음 달 할일 생성)</option>
              </select>
            </label>

            <div className="flex items-center gap-4 text-xs text-white/50">
              <span className="flex items-center gap-1">
                중요도
                {[1, 2, 3].map((n) => (
                  <button
                    type="button"
                    key={n}
                    aria-label={`중요도 ${n}`}
                    className={cn("text-lg leading-none", n <= form.priority ? "text-amber-400" : "text-white/20 hover:text-amber-300/70")}
                    onClick={() => setForm({ ...form, priority: form.priority === n ? 0 : n })}
                  >
                    ★
                  </button>
                ))}
              </span>
              <label className={cn("flex items-center gap-1.5", isNew && "hidden")}>
                <input
                  type="checkbox"
                  className="accent-orange-500"
                  checked={form.done}
                  onChange={async (e) => {
                    if (!(e.target.checked && !todo.done && onFinish)) return setForm({ ...form, done: e.target.checked });
                    if (await save(false)) onFinish({ ...todo, title: form.title });
                  }}
                />
                완료
              </label>
            </div>

            {todo.done && todo.done_note && (
              <div className="text-xs text-white/50">
                완료 코멘트
                <p className="mt-1 whitespace-pre-wrap text-sm text-white/80">{todo.done_note}</p>
              </div>
            )}

            {error && <p className="break-words text-xs text-red-300 light:text-red-700">{error}</p>}

            <div className="flex gap-2 pt-1">
              {!isNew && (
                <button type="button" className={cn(btn, "text-red-300 hover:bg-red-500/10 light:text-red-700")} onClick={() => send({ method: "DELETE" })}>
                  삭제
                </button>
              )}
              <span className="flex-1" />
              <button type="button" className={cn(btn, "border border-white/[0.1] text-white/70 hover:bg-white/10")} onClick={onClose}>
                취소
              </button>
              <button type="submit" className={cn(btn, "bg-orange-500 font-medium text-[#fff] hover:bg-orange-600")}>
                {isNew ? "추가" : "저장"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Checking a todo off asks when and how it was finished and what it led to; each 추가 할일 line becomes a new todo. */
export function FinishTodo({ todo, onClose, onChanged }: { todo: Todo; onClose: () => void; onChanged: () => void }) {
  const [doneOn, setDoneOn] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");
  const [followUps, setFollowUps] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  async function finish() {
    const r = await fetch(`${API}/api/todos/${todo.id}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done_on: doneOn, note, follow_ups: followUps.split("\n") }),
    }).catch(() => null);
    onChanged();
    if (r?.ok) return onClose();
    setError(r ? await r.text() : "로컬 서버에 연결할 수 없습니다.");
  }

  const input = "mt-1 w-full rounded-sm border border-white/[0.1] bg-white/[0.03] px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500/60";
  const btn = "rounded-sm px-3 py-1.5 text-sm";
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-label="할일 완료"
        className="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-white/[0.08] bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish();
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={todo.title}>
            완료 · {todo.title}
          </h2>
          <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <label className="block text-xs text-white/50">
            완료 날짜
            <input type="date" required className={input} value={doneOn} onChange={(e) => setDoneOn(e.target.value)} />
          </label>
          <label className="block text-xs text-white/50">
            완료 코멘트
            <textarea
              rows={3}
              autoFocus
              className={cn(input, "resize-y")}
              placeholder="어떻게 마무리했는지, 이어서 처리할 일이 생겼다면 그 내용"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="block text-xs text-white/50">
            추가 할일
            <textarea
              rows={3}
              className={cn(input, "resize-y")}
              placeholder="한 줄에 하나씩. 적은 줄마다 새 할일이 생깁니다"
              value={followUps}
              onChange={(e) => setFollowUps(e.target.value)}
            />
          </label>

          {error && <p className="break-words text-xs text-red-300 light:text-red-700">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={cn(btn, "border border-white/[0.1] text-white/70 hover:bg-white/10")} onClick={onClose}>
              취소
            </button>
            <button type="submit" className={cn(btn, "bg-orange-500 font-medium text-[#fff] hover:bg-orange-600")}>
              완료
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
