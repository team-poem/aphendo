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
import { Camera, ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useMediaQuery } from '@/hooks/use-media-query';

export interface CalendarEvent {
  id: string | number;
  name: string;
  time: string;
  datetime: string;
  done?: boolean;
}

export interface CalendarData {
  day: Date;
  events: CalendarEvent[];
}

export interface FullScreenCalendarProps {
  data: CalendarData[];
  onNewEvent?: () => void;
  selectedDay?: Date;
  onSelectDay?: (day: Date) => void;
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
  selectedDay: selectedDayProp,
  onSelectDay,
}: FullScreenCalendarProps) {
  const today = startOfToday();
  const [selectedDayState, setSelectedDayState] = React.useState(today);
  const selectedDay = selectedDayProp ?? selectedDayState;
  const setSelectedDay = onSelectDay ?? setSelectedDayState;
  const [currentMonth, setCurrentMonth] = React.useState(
    format(today, 'MMM-yyyy')
  );
  const firstDayCurrentMonth = parse(currentMonth, 'MMM-yyyy', new Date());
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const days = eachDayOfInterval({
    start: startOfWeek(firstDayCurrentMonth),
    end: endOfWeek(endOfMonth(firstDayCurrentMonth)),
  });

  function previousMonth() {
    const first = add(firstDayCurrentMonth, { months: -1 });
    setCurrentMonth(format(first, 'MMM-yyyy'));
  }

  function nextMonth() {
    const first = add(firstDayCurrentMonth, { months: 1 });
    setCurrentMonth(format(first, 'MMM-yyyy'));
  }

  function goToToday() {
    setCurrentMonth(format(today, 'MMM-yyyy'));
  }

  return (
    <div className="flex flex-1 flex-col bg-[#050505]">
      {/* ── Header ── */}
      <div className="flex flex-col space-y-4 p-4 md:flex-row md:items-center md:justify-between md:space-y-0 lg:flex-none border-b border-white/[0.06]">
        <div className="flex flex-auto">
          <div className="flex items-center gap-4">
            {/* Today date card */}
            <div className="hidden w-20 flex-col items-center justify-center rounded-sm border-[0.5px] border-white/[0.06] bg-[#0a0a0a] p-0.5 md:flex">
              <h1 className="p-1 text-xs uppercase text-white/40 tracking-wider">
                {format(today, 'MMM', { locale: ko })}
              </h1>
              <div className="flex w-full items-center justify-center rounded-sm border-[0.5px] border-white/[0.06] bg-[#050505] p-0.5 text-lg font-bold text-white">
                <span>{format(today, 'd')}</span>
              </div>
            </div>
            <div className="flex flex-col">
              <h2 className="text-base font-semibold text-white">
                {format(firstDayCurrentMonth, 'yyyy년 M월', { locale: ko })}
              </h2>
              <p className="text-xs text-white/40">
                {format(firstDayCurrentMonth, 'yyyy. M. d.', { locale: ko })} –{' '}
                {format(endOfMonth(firstDayCurrentMonth), 'yyyy. M. d.', { locale: ko })}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 md:flex-row md:gap-6">
          <div className="inline-flex w-full -space-x-px rounded-sm shadow-sm md:w-auto rtl:space-x-reverse">
            <Button
              onClick={previousMonth}
              className="rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 bg-[#0a0a0a] border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white"
              variant="outline"
              size="icon"
              aria-label="이전 달"
            >
              <ChevronLeft size={14} strokeWidth={2} />
            </Button>
            <Button
              onClick={goToToday}
              className="w-full rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 md:w-auto bg-[#0a0a0a] border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white text-xs"
              variant="outline"
            >
              오늘
            </Button>
            <Button
              onClick={nextMonth}
              className="rounded-none shadow-none first:rounded-s-sm last:rounded-e-sm focus-visible:z-10 bg-[#0a0a0a] border-[0.5px] border-white/[0.06] text-white/60 hover:bg-white/[0.04] hover:text-white"
              variant="outline"
              size="icon"
              aria-label="다음 달"
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
          <div className="hidden w-full border-x border-white/[0.06] lg:grid lg:grid-cols-7 lg:grid-rows-5">
            {days.map((day, dayIdx) => (
              <div
                key={dayIdx}
                onClick={() => setSelectedDay(day)}
                className={cn(
                  dayIdx === 0 && colStartClasses[getDay(day)],
                  !isSameMonth(day, firstDayCurrentMonth) && 'opacity-40',
                  'relative flex flex-col border-b border-r border-white/[0.06] hover:bg-white/[0.02] focus:z-10 cursor-pointer transition-colors',
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
                        'bg-orange-500 text-white font-semibold',
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
                <div className="flex-1 p-2.5">
                  {data
                    .filter(event => isSameDay(event.day, day))
                    .map(d => (
                      <div key={d.day.toString()} className="space-y-1.5">
                        {d.events.slice(0, 1).map(event => (
                          <div
                            key={event.id}
                            className="flex flex-col items-start gap-1 rounded-sm border-[0.5px] border-orange-500/20 bg-orange-500/[0.06] p-2 text-xs leading-tight"
                          >
                            <p title={event.name} className={cn('w-full truncate font-medium leading-none text-white', event.done && 'line-through text-white/40')}>
                              {event.name}
                            </p>
                            {event.time && (
                              <p className="leading-none text-white/40">
                                {event.time}
                              </p>
                            )}
                          </div>
                        ))}
                        {d.events.length > 1 && (
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
          <div className="isolate grid w-full grid-cols-7 grid-rows-5 border-x border-white/[0.06] lg:hidden">
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
                      'bg-orange-500 text-white font-semibold',
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
