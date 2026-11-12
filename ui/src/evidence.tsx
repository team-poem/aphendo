import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { Maximize2 } from "lucide-react";
import { imageUrl, type Capture } from "./api";
import { useLayer } from "./layer";
import type { Todo } from "./todo-detail";
import { evidenceOf } from "./todo-item";

const FIELDS = [
  ["sender", "발신자"],
  ["method", "제출방법"],
  ["contact", "담당자"],
  ["detail", "비고"],
] as const;

/** What a todo was read from: its stored capture(s) and the text the extractor pulled out next to it.
 *  Shown on hover beside the row, moved to stay inside the window. Nothing here is inferred. */
export function EvidenceCard({
  todo,
  source,
  captures,
  onKeep,
  onLeave,
  onClose,
  onOpenCapture,
}: {
  todo: Todo;
  /** The row it belongs to; the card sits beside it. */
  source: HTMLElement;
  captures: Capture[];
  onKeep: () => void;
  onLeave: () => void;
  onClose: () => void;
  onOpenCapture: (id: string) => void;
}) {
  useLayer(onClose);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: 0 });
  // Whatever happened to the row (removed, scrolled away, re-rendered elsewhere), a pointer resting on
  // neither the row nor the card means the user has moved on.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!source.contains(at) && !ref.current?.contains(at)) onLeave();
    };
    document.addEventListener("pointermove", move);
    return () => document.removeEventListener("pointermove", move);
  }, [source, onLeave]);
  useLayoutEffect(() => {
    const anchor = source.getBoundingClientRect();
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const gap = 8;
    const left = anchor.right + gap + width <= innerWidth ? anchor.right + gap : Math.max(gap, anchor.left - gap - width);
    const top = Math.min(Math.max(gap, anchor.top), innerHeight - height - gap);
    setPos({ left: Math.max(gap, Math.min(left, innerWidth - width - gap)), top: Math.max(gap, top) });
  }, [source, todo.id]);

  const shots = evidenceOf(todo).map((id) => captures.find((c) => c.id === id)).filter((c): c is Capture => !!c);
  const fields = FIELDS.filter(([k]) => todo[k]);
  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
      className="fixed z-50 flex max-h-[calc(100%-16px)] w-[min(380px,calc(100%-16px))] flex-col overflow-y-auto rounded-lg border border-white/[0.1] bg-popup p-3 text-sm shadow-2xl"
    >
      <p className="mb-2 text-xs font-semibold text-white/50">근거</p>
      {shots.length ? (
        shots.map((c) => (
          <figure key={c.id} className="mb-2">
            <button type="button" className="group relative block w-full overflow-hidden rounded border border-white/[0.1]" title="원본 크게 보기" onClick={() => onOpenCapture(c.id)}>
              <img src={imageUrl(c.id)} alt="원본 캡처" className="max-h-56 w-full object-contain object-top" />
              <span className="absolute right-1 top-1 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-[#fff]">
                <Maximize2 size={11} aria-hidden />
                크게 보기
              </span>
            </button>
            <figcaption className="mt-1 text-xs text-white/45">{format(new Date(c.created_at), "M/d (EEE) HH:mm 캡처", { locale: ko })}</figcaption>
          </figure>
        ))
      ) : (
        <p className="mb-2 rounded border border-dashed border-white/[0.15] px-2 py-3 text-center text-white/55">연결된 근거 없음 · 직접 입력한 할일</p>
      )}
      {fields.length > 0 && (
        <dl className="space-y-1.5">
          {fields.map(([k, label]) => (
            <div key={k}>
              <dt className="text-xs text-white/45">{label}</dt>
              <dd className="whitespace-pre-wrap break-words text-white/85">{todo[k]}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
