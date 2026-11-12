import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { cn } from "@/lib/utils";
import type { Todo } from "./todo-detail";
import { actions, dueDate, isOverdue } from "./todo-item";

const day = (iso: string) => format(new Date(iso), "M/d (EEE)", { locale: ko });

function Node({ t, kids }: { t: Todo; kids: Map<string, Todo[]> }) {
  const next = kids.get(t.id) ?? [];
  return (
    <li className="relative pl-6">
      <span
        aria-hidden
        className={cn("absolute left-0 top-2 size-3 rounded-full border-2", t.done ? "border-orange-500 bg-orange-500" : isOverdue(t) ? "border-red-500 bg-popup" : "border-orange-500 bg-popup")}
      />
      <button type="button" className="text-left text-[15px] leading-[1.5] text-white/90 hover:underline" onClick={() => actions.open(t.id)}>
        <span className={cn(t.done && "text-white/60 line-through")}>{t.title}</span>
      </button>
      <p className="text-sm text-white/55">
        {t.done ? `완료 ${t.done_at ? day(t.done_at) : ""}` : isOverdue(t) ? "기한 초과" : "진행 중"}
        {!t.done && t.due && ` · 마감 ${format(dueDate(t.due), "M/d (EEE)", { locale: ko })}`}
        {t.parent_id && ` · ${day(t.created_at)} 추가`}
      </p>
      {t.done_note && <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-white/[0.04] px-2.5 py-1.5 text-sm text-white/75">{t.done_note}</p>}
      {next.length > 0 && (
        <ol className="mt-3 space-y-3 border-l border-white/[0.15] pb-1 pl-3 [&>li>span]:-left-[19px]">
          {next.map((c) => (
            <Node key={c.id} t={c} kids={kids} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Work that led to more work: each todo checked off with follow-ups, and what came of those, newest first. */
export function FollowUpTimeline({ todos }: { todos: Todo[] }) {
  const ids = new Set(todos.map((t) => t.id));
  const kids = new Map<string, Todo[]>();
  for (const t of [...todos].sort((a, b) => a.created_at.localeCompare(b.created_at)))
    if (t.parent_id && ids.has(t.parent_id)) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
  const roots = todos
    .filter((t) => kids.has(t.id) && !(t.parent_id && ids.has(t.parent_id)))
    .sort((a, b) => (b.done_at ?? b.created_at).localeCompare(a.done_at ?? a.created_at));
  return (
    <section aria-label="할일 타임라인">
      <h2 className="text-base font-semibold">할일 타임라인</h2>
      <p className="mt-1 text-sm text-white/55">완료하면서 추가 할일을 만든 흐름입니다. 제목을 누르면 상세가 열립니다.</p>
      {roots.length ? (
        <ol className="mt-4 space-y-4">
          {roots.map((r) => (
            <li key={r.id} className="rounded-lg border border-white/[0.1] bg-surface p-4">
              <ol>
                <Node t={r} kids={kids} />
              </ol>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-white/[0.15] p-6 text-sm text-white/55">
          아직 흐름이 없습니다. 할일을 완료할 때 "추가 할일"을 넣으면 여기에 이어서 보입니다. 이번 버전 전에 만든 추가 할일은 연결 정보가 없어 나오지 않습니다.
        </p>
      )}
    </section>
  );
}
