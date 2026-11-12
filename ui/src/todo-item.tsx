import { differenceInCalendarDays, format, parse, startOfToday } from "date-fns";
import { ko } from "date-fns/locale";
import { AlertTriangle, Check, Paperclip, Repeat as RepeatIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { REPEAT_LABEL, type Todo } from "./todo-detail";

export const dueDate = (due: string) => parse(due, "yyyy-MM-dd", new Date());
export const evidenceOf = (t: Todo) => [t.capture_id, ...(t.extra_captures ?? [])].filter(Boolean);
const daysLeft = (due: string) => differenceInCalendarDays(dueDate(due), startOfToday());
export const isOverdue = (t: Todo) => !t.done && !!t.due && daysLeft(t.due) < 0;

/** Open before done, then soonest due (no due last), then more stars, then oldest. Todos carry a due date
 *  but no time, so there is no time to order by within a day. */
export const byOrder = (a: Todo, b: Todo) =>
  Number(a.done) - Number(b.done) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.priority - a.priority || a.created_at.localeCompare(b.created_at);

// main.tsx wires these to App state; rows render in many places and only need to call them.
export const actions = {
  setDone: (_t: Todo, _done: boolean) => {},
  open: (_id: string) => {},
  hover: (_t: Todo, _el: HTMLElement) => {},
  leave: () => {},
};

// D-3 before, D-day on, D+2 after the due date. Past due also says so in words and with an icon.
export function DDay({ due }: { due: string }) {
  const n = daysLeft(due);
  const cls = n < 0 ? "bg-red-500/15 text-red-300 light:text-red-700" : n <= 3 ? "bg-orange-500/15 text-orange-300 light:text-orange-700" : "bg-white/[0.08] text-white/60";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums leading-none", cls)} title={`마감 ${format(dueDate(due), "M/d (EEE)", { locale: ko })}`}>
      {n < 0 && <AlertTriangle size={11} aria-hidden />}
      {n === 0 ? "D-day" : n > 0 ? `D-${n}` : `D+${-n} 초과`}
    </span>
  );
}

const Stars = ({ n }: { n: number }) => (
  <span className="shrink-0 text-xs leading-none text-amber-500 light:text-amber-600" aria-label={`중요도 ${n}`} title={`중요도 ${n}`}>
    {"★".repeat(n)}
  </span>
);

/** One todo: checkbox, the whole title wrapped over as many lines as it needs, then a meta line (due, stars,
 *  repeat, evidence) below so nothing sits on top of the title. Hovering or keyboard-focusing the title shows
 *  its evidence; clicking it opens the detail. `dense` is the month cell: a size smaller and no D-day
 *  (the cell is the date). */
export function TodoRow({ t, dense }: { t: Todo; dense?: boolean }) {
  const overdue = isOverdue(t);
  const n = evidenceOf(t).length;
  const meta = dense ? t.priority > 0 || overdue : true;
  return (
    <li className={cn("flex items-start rounded-md hover:bg-white/[0.05]", dense ? "gap-1.5 px-1 py-0.5" : "gap-2.5 px-2 py-2")}>
      <input
        type="checkbox"
        className={cn("shrink-0 cursor-pointer accent-orange-500", dense ? "mt-[3px] size-3.5" : "mt-1 size-4")}
        aria-label={`${t.title} ${t.done ? "완료 해제" : "완료"}`}
        checked={t.done}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => actions.setDone(t, e.target.checked)}
      />
      <button
        type="button"
        className="min-w-0 flex-1 rounded-sm text-left outline-offset-2"
        onClick={(e) => {
          e.stopPropagation();
          actions.leave();
          actions.open(t.id);
        }}
        onMouseEnter={(e) => actions.hover(t, e.currentTarget)}
        onMouseLeave={() => actions.leave()}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && actions.hover(t, e.currentTarget)}
        onBlur={() => actions.leave()}
      >
        <span
          className={cn(
            "block break-keep [overflow-wrap:anywhere]",
            dense ? "text-sm leading-[1.4]" : "text-[15px] leading-[1.5]",
            t.done ? "text-white/55 line-through" : "text-white/90",
          )}
        >
          {t.title}
        </span>
        {meta && (
          <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-white/50", dense ? "mt-0.5" : "mt-1")}>
            {t.done && (
              <span className="inline-flex items-center gap-0.5 text-xs">
                <Check size={12} aria-hidden />
                완료
              </span>
            )}
            {!dense && !t.done && t.due && <DDay due={t.due} />}
            {dense && overdue && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-red-300 light:text-red-700">
                <AlertTriangle size={11} aria-hidden />
                기한 초과
              </span>
            )}
            {t.priority > 0 && <Stars n={t.priority} />}
            {!dense && t.repeat && (
              <span className="inline-flex items-center gap-0.5 text-xs">
                <RepeatIcon size={12} aria-hidden />
                {REPEAT_LABEL[t.repeat]}
              </span>
            )}
            {!dense && n > 0 && (
              <span className="inline-flex items-center gap-0.5 text-xs" title="연결된 캡처">
                <Paperclip size={12} aria-hidden />
                근거 {n}
              </span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}
