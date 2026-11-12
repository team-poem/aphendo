import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { API } from "./api";
import { cn } from "@/lib/utils";
import { useLayer } from "./layer";
import { DiscardBar, useGuardedClose } from "./todo-detail";
import { applyColors, checkContrast, COLOR_LABEL, colorsOf, PRESETS, saveTheme, type Colors, type Preset, type ThemeChoice } from "./theme";

export type ConfigView = { has_token: boolean };
type Probe = { status: "ok"; tools: string[] } | { status: "unauthorized" } | { status: "unreachable"; error: string };
type Result = { tone: "ok" | "bad"; text: string } | null;

export const configured = (c: ConfigView | null) => !!c?.has_token;

type Tauri = { core: { invoke<T>(cmd: string): Promise<T> }; app: { getVersion(): Promise<string> } };
const tauri = (window as unknown as { __TAURI__?: Tauri }).__TAURI__;

/** Desktop only: current version, a manual check, and install of a newer release. */
function Update() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "checking" | "latest" | "installing" } | { kind: "available"; next: string } | { kind: "error"; text: string }>({ kind: "idle" });
  useEffect(() => {
    tauri?.app.getVersion().then(setVersion);
  }, []);
  if (!tauri) return null;

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const next = await tauri.core.invoke<string | null>("check_update");
      setState(next ? { kind: "available", next } : { kind: "latest" });
    } catch (e) {
      setState({ kind: "error", text: `확인 실패: ${e}` });
    }
  };
  const install = async () => {
    setState({ kind: "installing" });
    try {
      await tauri.core.invoke("install_update");
    } catch (e) {
      setState({ kind: "error", text: `업데이트 실패: ${e}` });
    }
  };

  const btn = "rounded-sm px-3 py-1.5 text-sm disabled:opacity-40";
  return (
    <div className="mb-3 flex items-center gap-2 border-b border-white/[0.06] pb-3 text-xs text-white/50">
      <span className="flex-1">
        버전 {version && `v${version}`}
        {state.kind === "latest" && <span className="ml-2 text-emerald-300 light:text-emerald-700">최신 버전입니다</span>}
        {state.kind === "available" && <span className="ml-2 text-orange-400">v{state.next} 사용 가능</span>}
        {state.kind === "error" && <span className="ml-2 break-words text-red-300 light:text-red-700">{state.text}</span>}
      </span>
      {state.kind === "available" || state.kind === "installing" ? (
        <button type="button" className={cn(btn, "bg-orange-500 font-medium text-[#fff] hover:bg-orange-600")} disabled={state.kind === "installing"} onClick={install}>
          {state.kind === "installing" ? "설치 중…" : "업데이트"}
        </button>
      ) : (
        <button type="button" className={cn(btn, "border border-white/[0.1] text-white/70 hover:bg-white/10 hover:text-white")} disabled={state.kind === "checking"} onClick={check}>
          {state.kind === "checking" ? "확인 중…" : "업데이트 확인"}
        </button>
      )}
    </div>
  );
}

export async function fetchConfig(): Promise<ConfigView | null> {
  const r = await fetch(`${API}/api/config`).catch(() => null);
  return r?.ok ? r.json() : null;
}

const json = (method: string, body: object): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function describe(p: Probe): Result {
  if (p.status === "ok")
    return p.tools.includes("extract_todos")
      ? { tone: "ok", text: "연결됨 · extract_todos 사용 가능" }
      : { tone: "bad", text: `연결은 됐지만 extract_todos 도구가 없습니다 (${p.tools.join(", ") || "도구 없음"})` };
  if (p.status === "unauthorized") return { tone: "bad", text: "401 · 토큰이 맞지 않습니다" };
  return { tone: "bad", text: `서버에 연결할 수 없습니다 · ${p.error}` };
}

/** A preset as a tiny window: side, body and a card in its own colors. */
function Swatch({ c }: { c: Colors }) {
  return (
    <span className="flex h-12 w-full overflow-hidden rounded border border-black/10" aria-hidden>
      <span className="w-1/3" style={{ background: c.side }} />
      <span className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: c.body }}>
        <span className="h-1.5 w-3/4 rounded-sm" style={{ background: c.text, opacity: 0.8 }} />
        <span className="flex h-4 items-center gap-1 rounded-sm px-1" style={{ background: c.card, boxShadow: "0 0 0 1px rgb(0 0 0 / 0.08)" }}>
          <span className="size-2 rounded-full" style={{ background: c.accent }} />
          <span className="h-1 flex-1 rounded-sm" style={{ background: c.text, opacity: 0.5 }} />
        </span>
      </span>
    </span>
  );
}

/** Pick a preset, then override any of its six colors. Every change shows on the app behind at once;
 *  only 저장 keeps it. */
function ThemePicker({ value, onChange }: { value: ThemeChoice; onChange: (t: ThemeChoice) => void }) {
  const colors = colorsOf(value);
  const { issues, fixed } = checkContrast(colors);
  return (
    <fieldset className="mb-4 border-b border-white/[0.08] pb-4">
      <legend className="mb-2 text-sm font-semibold">화면 테마</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={value.preset === p}
            onClick={() => onChange({ preset: p, custom: {} })}
            className={cn("rounded-md border p-1.5 text-left text-xs", value.preset === p ? "border-orange-500 ring-1 ring-orange-500" : "border-white/[0.12] hover:border-white/30")}
          >
            <Swatch c={PRESETS[p].colors} />
            <span className="mt-1 block font-medium">{PRESETS[p].label}</span>
          </button>
        ))}
      </div>
      <p className="mb-1.5 mt-3 text-xs text-white/55">색 직접 지정 · {PRESETS[value.preset].label} 기준</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        {(Object.keys(COLOR_LABEL) as (keyof Colors)[]).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="color" className="h-7 w-9 cursor-pointer rounded border border-white/[0.15] bg-transparent" value={colors[k]} onChange={(e) => onChange({ ...value, custom: { ...value.custom, [k]: e.target.value } })} />
            {COLOR_LABEL[k]}
            {value.custom[k] && <span className="text-xs text-orange-300 light:text-orange-700">변경됨</span>}
          </label>
        ))}
      </div>
      {issues.length > 0 && (
        <div role="status" className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 light:text-red-700">
          {issues.map((i) => (
            <p key={i}>{i}</p>
          ))}
          <button type="button" className="mt-1.5 rounded-sm border border-current px-2 py-0.5 font-medium" onClick={() => onChange({ ...value, custom: { ...value.custom, text: fixed.text, accent: fixed.accent } })}>
            읽기 쉽게 자동 보정
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={!Object.keys(value.custom).length}
        className="mt-2 rounded-sm border border-white/[0.12] px-2.5 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-40"
        onClick={() => onChange({ ...value, custom: {} })}
      >
        {PRESETS[value.preset].label} 기본값으로 되돌리기
      </button>
    </fieldset>
  );
}

export function Settings({
  config,
  theme,
  onTheme,
  onClose,
  onSaved,
}: {
  config: ConfigView | null;
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  onClose: () => void;
  onSaved: (c: ConfigView) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [draft, setDraft] = useState(theme);
  // The app behind is the preview; leaving without 저장 puts the saved theme back.
  useEffect(() => applyColors(colorsOf(draft)), [draft]);
  const close = () => {
    applyColors(colorsOf(theme));
    onClose();
  };
  const guard = useGuardedClose(!!token.trim() || JSON.stringify(draft) !== JSON.stringify(theme), close);
  const ref = useRef<HTMLFormElement>(null);
  useLayer(guard.request, ref);

  const body = () => (token.trim() ? { mcp_token: token.trim() } : {});

  async function run(path: string, init: RequestInit, done: (r: Response) => Promise<Result>) {
    setBusy(true);
    setResult(null);
    const r = await fetch(`${API}${path}`, init).catch(() => null);
    setResult(!r ? { tone: "bad", text: "로컬 서버에 연결할 수 없습니다." } : r.ok ? await done(r) : { tone: "bad", text: await r.text() });
    setBusy(false);
  }

  const test = () => run("/api/config/test", json("POST", body()), async (r) => describe(await r.json()));
  const saveThemeOnly = () => {
    saveTheme(draft);
    onTheme(draft);
  };
  const save = () => {
    saveThemeOnly();
    // Nothing typed: the token stays as it is, so there is nothing to send.
    if (!token.trim() && config?.has_token) return setResult({ tone: "ok", text: "저장했습니다" });
    return run("/api/config", json("PUT", body()), async (r) => {
      const saved: ConfigView = await r.json();
      setToken("");
      onSaved(saved);
      return { tone: "ok", text: saved.has_token ? "저장했습니다" : "저장했습니다 · 토큰이 아직 없습니다" };
    });
  };

  const field = "w-full rounded-sm border border-white/[0.1] bg-white/[0.03] px-2 py-1.5 text-sm outline-none focus:border-orange-500/60";
  const btn = "rounded-sm px-3 py-1.5 text-sm disabled:opacity-40";
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-4" onClick={guard.request}>
      <form
        ref={ref}
        role="dialog"
        aria-label="설정"
        className="max-h-full w-full max-w-xl overflow-y-auto rounded-lg border border-white/[0.1] bg-popup p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">설정</h2>
          <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기 (Esc)" aria-label="닫기" onClick={guard.request}>
            <X size={16} />
          </button>
        </div>
        {guard.asking && (
          <div className="-mx-4 mb-3">
            <DiscardBar onKeep={guard.keep} onDiscard={close} />
          </div>
        )}
        <ThemePicker value={draft} onChange={setDraft} />
        <Update />
        <label className="mb-3 block text-xs text-white/50">
          토큰
          <input
            className={cn(field, "mt-1")}
            type="password"
            autoComplete="off"
            placeholder={config?.has_token ? "저장됨 · 바꿀 때만 입력" : "관리자에게 받은 접속 토큰"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {result && (
          <p role="status" className={cn("mb-3 break-words text-xs", result.tone === "ok" ? "text-emerald-300 light:text-emerald-700" : "text-red-300 light:text-red-700")}>
            {result.text}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={cn(btn, "border border-white/[0.1] text-white/70 hover:bg-white/10 hover:text-white")} disabled={busy || (!token.trim() && !config?.has_token)} onClick={test}>
            {busy ? "확인 중…" : "연결 확인"}
          </button>
          <button type="submit" className={cn(btn, "bg-orange-500 font-medium text-[#fff] hover:bg-orange-600")} disabled={busy}>
            저장
          </button>
        </div>
      </form>
    </div>
  );
}
