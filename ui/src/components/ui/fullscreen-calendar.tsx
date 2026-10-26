import * as React from 'react';
import {
  add,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isEqual,
  isSameDay,
  isSameMonth,
  isToday,
  parse,
  startOfToday,
  startOfWeek,
} from 'date-fns';
import { ko } from 'date-fns/locale';
import { Camera, ChevronLeft, ChevronRight, Moon, Plus, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export interface CalendarEvent {
  id: string | number;
  name: string;
  time: string;
  datetime: string;
  done?: boolean;
  priority?: number;
}

export interface CalendarData {
  day: Date;
  events: CalendarEvent[];
}

export interface FullScreenCalendarProps {
  data: CalendarData[];
  onNewEvent?: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  selectedDay?: Date;
  onSelectDay?: (day: Date) => void;
  /** Mouse down on empty header space; the widget uses it to move the window. */
  onHeaderMouseDown?: (e: React.MouseEvent) => void;
  onEventClick?: (id: string | number) => void;
  /** The visible week or month (not the padding days), whenever it changes. */
  onRangeChange?: (start: Date, end: Date) => void;
  showAll?: boolean;
  onToggleAll?: () => void;
  onAdd?: () => void;
}

const colStartClasses = [
  '',
  'col-start-2',
  'col-start-3',
  'col-start-4',
  'col-start-5',
  'col-start-6',
  'col-start-7',
];

export function FullScreenCalendar({
  data,
  onNewEvent,
  theme,
  onToggleTheme,
  selectedDay: selectedDayProp,
  onSelectDay,
  onHeaderMouseDown,
  onEventClick,
  onRangeChange,
  showAll,
  onToggleAll,
  onAdd,
}: FullScreenCalendarProps) {
  const today = startOfToday();
  const [selectedDayState, setSelectedDayState] = React.useState(today);
  const selectedDay = selectedDayProp ?? selectedDayState;
  const setSelectedDay = onSelectDay ?? setSelectedDayState;
  const [currentMonth, setCurrentMonth] = React.useState(
    format(today, 'MMM-yyyy')
  );
  const firstDayCurrentMonth = parse(currentMonth, 'MMM-yyyy', new Date());
  // A day picked from outside (e.g. a reopened todo's due date) brings its month into view.
  React.useEffect(() => {
    if (!isSameMonth(selectedDay, firstDayCurrentMonth)) setCurrentMonth(format(selectedDay, 'MMM-yyyy'));
  }, [selectedDay.getTime()]);
  const [week, setWeek] = React.useState(false);

  // Week mode follows the selected day; month mode pages independently of it.
  const days = week
    ? eachDayOfInterval({ start: startOfWeek(selectedDay), end: endOfWeek(selectedDay) })
    : eachDayOfInterval({
        start: startOfWeek(firstDayCurrentMonth),
        end: endOfWeek(endOfMonth(firstDayCurrentMonth)),
      });

  const rangeStart = week ? days[0] : firstDayCurrentMonth;
  const rangeEnd = week ? days[6] : endOfMonth(firstDayCurrentMonth);
  React.useEffect(() => {
    onRangeChange?.(rangeStart, rangeEnd);
  }, [rangeStart.getTime(), rangeEnd.getTime()]);

  function step(n: number) {
    if (week) return setSelectedDay(add(selectedDay, { weeks: n }));
    setCurrentMonth(format(add(firstDayCurrentMonth, { months: n }), 'MMM-yyyy'));
  }

  function goToToday() {
    setCurrentMonth(format(today, 'MMM-yyyy'));
    setSelectedDay(today);
  }

  function setMode(w: boolean) {
    setWeek(w);
    if (!w) setCurrentMonth(format(selectedDay, 'MMM-yyyy'));
  }

  const segment = (on: boolean) =>
    cn(
      'rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm border-[0.5px] border-white/[0.06] text-xs',
      on ? 'bg-white/10 text-white' : 'bg-surface text-white/50 hover:bg-white/[0.04] hover:text-white'
    );

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* ── Header ── */}
      <div onMouseDown={onHeaderMouseDown} className="flex select-none flex-col space-y-4 p-4 md:flex-row md:items-center md:justify-between md:space-y-0 lg:flex-none border-b border-white/[0.06]">
        <div className="flex flex-auto">
          <div className="flex items-center gap-4">
            {/* Today date card */}
            <div className="hidden w-20 flex-col items-center justify-center rounded-sm border-[0.5px] border-white/[0.06] bg-surface p-0.5 md:flex">
              <h1 className="p-1 text-xs uppercase text-white/40 tracking-wider">
                {format(today, 'MMM', { locale: ko })}
              </h1>
              <div className="flex w-full items-center justify-center rounded-sm border-[0.5px] border-white/[0.06] bg-background p-0.5 text-lg font-bold text-white">
                <span>{format(today, 'd')}</span>
              </div>
            </div>
            <div className="flex flex-col">
              <h2 className="text-base font-semibold text-white">
                {format(week ? days[0] : firstDayCurrentMonth, 'yyyy년 M월', { locale: ko })}
                {week && ' 주간'}
              </h2>
              <p className="text-xs text-white/40">
                {format(week ? days[0] : firstDayCurrentMonth, 'yyyy. M. d.', { locale: ko })} –{' '}
                {format(week ? days[6] : endOfMonth(firstDayCurrentMonth), 'yyyy. M. d.', { locale: ko })}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 md:flex-row md:gap-6">
          <div className="inline-flex w-full -space-x-px md:w-auto">
            <Button variant="outline" className={cn(segment(!week), 'w-full md:w-auto')} onClick={() => setMode(false)}>
              월간
            </Button>
            <Button variant="outline" className={cn(segment(week), 'w-full md:w-auto')} onClick={() => setMode(true)}>
              주간
            </Button>
            {onToggleAll && (
              <Button
                variant="outline"
                className={cn(segment(!!showAll), 'ml-2 w-full md:w-auto', showAll && 'bg-orange-500/15 text-orange-400')}
                title={week ? '이번 주 할일 전체를 목록에' : '이번 달 할일 전체를 목록에'}
                onClick={onToggleAll}
              >
                전체
              </Button>
            )}
          </div>
          <div className="inline-flex w-full -space-x-px rounded-sm shadow-sm md:w-auto rtl:space-x-reverse">
            <Button
              onClick={() => step(-1)}
              className="rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 bg-surface border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white"
              variant="outline"
              size="icon"
              aria-label={week ? '이전 주' : '이전 달'}
            >
              <ChevronLeft size={14} strokeWidth={2} />
            </Button>
            <Button
              onClick={goToToday}
              className="w-full rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 md:w-auto bg-surface border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white text-xs"
              variant="outline"
            >
              오늘
            </Button>
            <Button
              onClick={() => step(1)}
              className="rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 bg-surface border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white"
              variant="outline"
              size="icon"
              aria-label={week ? '다음 주' : '다음 달'}
            >
              <ChevronRight size={14} strokeWidth={2} />
            </Button>
          </div>

          {onNewEvent && (
            <>
              <Separator
                orientation="vertical"
                className="hidden h-5 md:block bg-white/[0.06]"
              />
              <Separator
                orientation="horizontal"
                className="block w-full md:hidden bg-white/[0.06]"
              />

              <Button
                className="w-full gap-2 md:w-auto bg-orange-500/[0.08] border-[0.5px] border-orange-500/20 text-orange-400 hover:bg-orange-500/[0.15] rounded-sm text-xs"
                onClick={onNewEvent}
                title="화면 캡처 (Alt+Shift+S)"
              >
                <Camera size={14} strokeWidth={2} />
                <span>캡처</span>
              </Button>
            </>
          )}

          {onAdd && (
            <Button
              className="w-full gap-2 md:w-auto bg-surface border-[0.5px] border-white/[0.06] text-white/70 hover:bg-white/[0.04] hover:text-white rounded-sm text-xs"
              variant="outline"
              onClick={onAdd}
              title="캡처 없이 할일 직접 추가"
            >
              <Plus size={14} strokeWidth={2} />
              <span>할일</span>
            </Button>
          )}

          <Button
            className="w-full gap-2 md:w-auto bg-surface border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white rounded-sm text-xs"
            variant="outline"
            onClick={onToggleTheme}
            title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          >
            {theme === 'dark' ? <Sun size={14} strokeWidth={2} /> : <Moon size={14} strokeWidth={2} />}
          </Button>
        </div>
      </div>

      {/* ── Grid ── */}
      <div className="lg:flex lg:flex-auto lg:flex-col">
        {/* Week-day labels */}
        <div className="grid grid-cols-7 border-b border-white/[0.06] text-center text-xs font-medium leading-6 text-white/40 lg:flex-none">
          {['일', '월', '화', '수', '목', '금', '토'].map((d, i) => (
            <div
              key={d}
              className={cn('py-2.5', i < 6 && 'border-r border-white/[0.06]')}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Days */}
        <div className="flex text-xs leading-6 lg:flex-auto">
          {/* Desktop grid */}
          <div className={cn('w-full border-x border-white/[0.06]', week ? 'grid min-h-64 grid-cols-7' : 'hidden lg:grid lg:grid-cols-7 lg:grid-rows-5')}>
            {days.map((day, dayIdx) => (
              <div
                key={dayIdx}
                onClick={() => setSelectedDay(day)}
                className={cn(
                  dayIdx === 0 && colStartClasses[getDay(day)],
                  !week && !isSameMonth(day, firstDayCurrentMonth) && 'opacity-40',
                  'relative flex min-w-0 flex-col border-b border-r border-white/[0.06] hover:bg-white/[0.02] focus:z-10 cursor-pointer transition-colors',
                  isEqual(day, selectedDay) && 'bg-orange-500/[0.04]'
                )}
              >
                <header className="flex items-center justify-between p-2.5">
                  <button
                    type="button"
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full text-xs transition-colors',
                      isToday(day) &&
                        !isEqual(day, selectedDay) &&
                        'text-orange-400 font-semibold',
                      isEqual(day, selectedDay) &&
                        isToday(day) &&
                        'bg-orange-500 text-[#fff] font-semibold',
                      isEqual(day, selectedDay) &&
                        !isToday(day) &&
                        'bg-white/10 text-white font-semibold',
                      !isEqual(day, selectedDay) &&
                        !isToday(day) &&
                        'text-white/60 hover:text-white'
                    )}
                  >
                    <time dateTime={format(day, 'yyyy-MM-dd')}>
                      {format(day, 'd')}
                    </time>
                  </button>
                </header>
                <div className={cn('flex-1', week ? 'p-1' : 'p-2.5')}>
                  {data
                    .filter(event => isSameDay(event.day, day))
                    .map(d => (
                      <div key={d.day.toString()} className="space-y-1.5">
                        {(week ? d.events : d.events.slice(0, 1)).map(event => (
                          <div
                            key={event.id}
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedDay(day);
                              onEventClick?.(event.id);
                            }}
                            className="flex cursor-pointer flex-col hover:border-orange-500/50 items-start gap-1 rounded-sm border-[0.5px] border-orange-500/20 bg-orange-500/[0.06] p-2 text-xs leading-tight"
                          >
                            <p title={event.name} className={cn('w-full font-medium text-white', week ? 'break-words leading-snug' : 'truncate leading-none', event.done && 'line-through text-white/40')}>
                              {!!event.priority && <span className="mr-0.5 text-amber-400">{'★'.repeat(event.priority)}</span>}
                              {event.name}
                            </p>
                            {event.time && (
                              <p className="leading-none text-white/40">
                                {event.time}
                              </p>
                            )}
                          </div>
                        ))}
                        {!week && d.events.length > 1 && (
                          <div className="text-xs leading-4 text-orange-400/70">
                            +{d.events.length - 1}개 더
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>

          {/* Mobile grid */}
          <div className={cn('isolate grid w-full grid-cols-7 grid-rows-5 border-x border-white/[0.06] lg:hidden', week && 'hidden')}>
            {days.map((day, dayIdx) => (
              <button
                onClick={() => setSelectedDay(day)}
                key={dayIdx}
                type="button"
                className={cn(
                  !isSameMonth(day, firstDayCurrentMonth) && 'opacity-40',
                  'flex h-14 flex-col border-b border-r border-white/[0.06] px-3 py-2 hover:bg-white/[0.02] focus:z-10 transition-colors',
                  isEqual(day, selectedDay) && 'bg-orange-500/[0.04]'
                )}
              >
                <time
                  dateTime={format(day, 'yyyy-MM-dd')}
                  className={cn(
                    'ml-auto flex size-6 items-center justify-center rounded-full text-xs',
                    isToday(day) &&
                      !isEqual(day, selectedDay) &&
                      'text-orange-400 font-semibold',
                    isEqual(day, selectedDay) &&
                      isToday(day) &&
                      'bg-orange-500 text-[#fff] font-semibold',
                    isEqual(day, selectedDay) &&
                      !isToday(day) &&
                      'bg-white/10 text-white font-semibold',
                    !isEqual(day, selectedDay) &&
                      !isToday(day) &&
                      'text-white/60'
                  )}
                >
                  {format(day, 'd')}
                </time>
                {data.filter(date => isSameDay(date.day, day)).length > 0 && (
                  <div className="-mx-0.5 mt-auto flex flex-wrap-reverse">
                    {data
                      .filter(date => isSameDay(date.day, day))
                      .flatMap(date =>
                        date.events.map(event => (
                          <span
                            key={event.id}
                            className={cn('mx-0.5 mt-1 h-1.5 w-1.5 rounded-full bg-orange-400/60', event.done && 'bg-white/20')}
                          />
                        ))
                      )}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
