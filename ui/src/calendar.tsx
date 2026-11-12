import { useEffect, useState } from "react";
import { addDays, addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from "date-fns";
import { ko } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Todo } from "./todo-detail";
import { TodoRow } from "./todo-item";

/** Todos shown in a month cell before the rest collapse into "N개 더 보기". */
const MONTH_ROWS = 3;
const key = (d: Date) => format(d, "yyyy-MM-dd");
type ByDay = Map<string, Todo[]>;

const monthDays = (month: Date) => eachDayOfInterval({ start: startOfWeek(startOfMonth(month)), end: endOfWeek(endOfMonth(month)) });
/** Monday to Friday of the week holding `d`. */
export const workWeek = (d: Date) => {
  const mon = startOfWeek(d, { weekStartsOn: 1 });
  return eachDayOfInterval({ start: mon, end: addDays(mon, 4) });
};

const dayNum = (day: Date, selected: Date) =>
  cn(
    "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
    isToday(day) ? "bg-orange-500 font-semibold text-[#fff]" : isSameDay(day, selected) ? "bg-white/15 font-semibold text-white" : "text-white/70",
  );

/** Sunday-first month with the weekend. Each cell lists its first few todos (open first) and links to the full day. */
export function MonthGrid({ month, byDay, selected, onDay }: { month: Date; byDay: ByDay; selected: Date; onDay: (d: Date) => void }) {
  const days = monthDays(month);
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-white/[0.08] bg-background text-center text-xs font-medium text-white/50">
        {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
          <div key={d} className={cn("py-2", i === 0 && "text-red-400/80 light:text-red-600/80")}>
            {d}
          </div>
        ))}
      </div>
      {/* Wide: titles in each cell. Narrow: dots, and the day list on tap. */}
      <div className="hidden flex-1 auto-rows-[minmax(7.5rem,auto)] grid-cols-7 md:grid">
        {days.map((day) => {
          const todos = byDay.get(key(day)) ?? [];
          const more = todos.length - MONTH_ROWS;
          return (
            <div
              key={key(day)}
              onClick={() => onDay(day)}
              className={cn(
                "flex min-w-0 cursor-pointer flex-col border-b border-r border-white/[0.06] p-1 hover:bg-white/[0.02]",
                !isSameMonth(day, month) && "opacity-45",
                isSameDay(day, selected) && "bg-orange-500/[0.05]",
              )}
            >
              <div className="flex items-center gap-1 p-0.5">
                <time dateTime={key(day)} className={dayNum(day, selected)}>
                  {format(day, "d")}
                </time>
                {isToday(day) && <span className="text-xs font-semibold text-orange-500">오늘</span>}
              </div>
              <ul className="min-w-0 space-y-0.5">
                {todos.slice(0, MONTH_ROWS).map((t) => (
                  <TodoRow key={t.id} t={t} dense />
                ))}
              </ul>
              {more > 0 && (
                <button
                  type="button"
                  className="mt-auto self-start rounded px-1 py-0.5 text-xs font-medium text-orange-300 hover:bg-orange-500/10 light:text-orange-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDay(day);
                  }}
                >
                  {more}개 더 보기
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-7 md:hidden">
        {days.map((day) => {
          const todos = byDay.get(key(day)) ?? [];
          const open = todos.filter((t) => !t.done).length;
          return (
            <button
              key={key(day)}
              type="button"
              onClick={() => onDay(day)}
              aria-label={`${format(day, "M월 d일", { locale: ko })} 할일 ${todos.length}개`}
              className={cn("flex h-16 flex-col items-center gap-1 border-b border-r border-white/[0.06] pt-1.5", !isSameMonth(day, month) && "opacity-45")}
            >
              <span className={dayNum(day, selected)}>{format(day, "d")}</span>
              {todos.length > 0 && <span className={cn("text-xs font-semibold tabular-nums", open ? "text-orange-300 light:text-orange-700" : "text-white/40")}>{open || "✓"}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Monday to Friday as columns of todos stacked top-down, each card as tall as its title. No time grid.
 *  Narrow windows get the same days as one vertical list. Day headers stick while scrolling. */
export function WeekBoard({ anchor, byDay, onDay }: { anchor: Date; byDay: ByDay; onDay: (d: Date) => void }) {
  const days = workWeek(anchor);
  const weekend = [addDays(days[4], 1), addDays(days[4], 2)].map((d) => ({ d, n: byDay.get(key(d))?.length ?? 0 })).filter((w) => w.n > 0);
  return (
    <div className="flex min-h-full flex-col">
      {weekend.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] bg-orange-500/[0.06] px-4 py-2 text-sm text-white/80">
          <span>주말에도 마감인 할일이 있습니다.</span>
          {weekend.map(({ d, n }) => (
            <button key={key(d)} type="button" className="rounded border border-orange-500/40 px-2 py-0.5 font-medium text-orange-300 hover:bg-orange-500/10 light:text-orange-700" onClick={() => onDay(d)}>
              {format(d, "M/d (EEE)", { locale: ko })} {n}개 보기
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-1 flex-col lg:grid lg:grid-cols-5">
        {days.map((day) => {
          const todos = byDay.get(key(day)) ?? [];
          const today = isToday(day);
          return (
            <section key={key(day)} className={cn("flex min-w-0 flex-col border-white/[0.06] lg:border-r", today && "bg-orange-500/[0.04]")} aria-label={format(day, "M월 d일 EEEE", { locale: ko })}>
              <button
                type="button"
                onClick={() => onDay(day)}
                title="이 날짜의 할일 목록 · 추가"
                className={cn(
                  "sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-2 text-left backdrop-blur",
                  today ? "border-orange-500 bg-orange-500/[0.12]" : "border-white/[0.08] bg-background/95",
                )}
              >
                <span className={cn("text-sm", today ? "font-semibold text-orange-300 light:text-orange-700" : "text-white/55")}>{format(day, "EEE", { locale: ko })}</span>
                <span className={cn("text-lg font-semibold tabular-nums", today ? "text-orange-300 light:text-orange-700" : "text-white/90")}>{format(day, "M/d")}</span>
                {today && <span className="rounded bg-orange-500 px-1.5 py-0.5 text-xs font-semibold text-[#fff]">오늘</span>}
                <span className="ml-auto text-xs tabular-nums text-white/45">{todos.length ? `${todos.length}개` : ""}</span>
              </button>
              {todos.length ? (
                <ul className="space-y-1 p-1.5">
                  {todos.map((t) => (
                    <TodoRow key={t.id} t={t} />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-sm text-white/35">할일 없음</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The small month in the side panel. Pages on its own and follows the main view when that moves. */
export function MiniCalendar({ anchor, byDay, onPick }: { anchor: Date; byDay: ByDay; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  useEffect(() => setMonth(startOfMonth(anchor)), [anchor.getTime()]);
  const btn = "rounded p-1 text-white/60 hover:bg-white/10 hover:text-white";
  return (
    <div className="px-3 pt-3">
      <div className="mb-1 flex items-center">
        <h2 className="flex-1 text-base font-semibold">{format(month, "yyyy년 M월")}</h2>
        <button type="button" className={btn} aria-label="이전 달" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className={btn} aria-label="다음 달" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
          <span key={d} className="py-1 text-white/45">
            {d}
          </span>
        ))}
        {monthDays(month).map((day) => {
          const open = (byDay.get(key(day)) ?? []).some((t) => !t.done);
          return (
            <button
              key={key(day)}
              type="button"
              onClick={() => onPick(day)}
              aria-label={format(day, "M월 d일", { locale: ko }) + (open ? " · 할일 있음" : "")}
              className={cn(
                "relative mx-auto flex size-7 items-center justify-center rounded-full tabular-nums hover:bg-white/10",
                !isSameMonth(day, month) && "opacity-40",
                isToday(day) ? "bg-orange-500 font-semibold text-[#fff] hover:bg-orange-600" : isSameDay(day, anchor) ? "bg-white/15 font-semibold" : "text-white/80",
              )}
            >
              {format(day, "d")}
              {open && <span className={cn("absolute bottom-0.5 size-1 rounded-full", isToday(day) ? "bg-[#fff]" : "bg-orange-500")} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
