import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { API } from "./api";
import { cn } from "@/lib/utils";

export type ConfigView = { mcp_url: string | null; has_token: boolean };
type Probe = { status: "ok"; tools: string[] } | { status: "unauthorized" } | { status: "unreachable"; error: string };
type Result = { tone: "ok" | "bad"; text: string } | null;

export const configured = (c: ConfigView | null) => !!c?.mcp_url && c.has_token;

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

export function Settings({ config, onClose, onSaved }: { config: ConfigView | null; onClose: () => void; onSaved: (c: ConfigView) => void }) {
  const [url, setUrl] = useState(config?.mcp_url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const body = () => ({ mcp_url: url.trim(), ...(token.trim() && { mcp_token: token.trim() }) });

  async function run(path: string, init: RequestInit, done: (r: Response) => Promise<Result>) {
    setBusy(true);
    setResult(null);
    const r = await fetch(`${API}${path}`, init).catch(() => null);
    setResult(!r ? { tone: "bad", text: "로컬 서버에 연결할 수 없습니다." } : r.ok ? await done(r) : { tone: "bad", text: await r.text() });
    setBusy(false);
  }

  const test = () => run("/api/config/test", json("POST", body()), async (r) => describe(await r.json()));
  const save = () =>
    run("/api/config", json("PUT", body()), async (r) => {
      const saved: ConfigView = await r.json();
      setToken("");
      onSaved(saved);
      return { tone: "ok", text: saved.has_token ? "저장했습니다" : "저장했습니다 · 토큰이 아직 없습니다" };
    });

  const field = "w-full rounded-sm border border-white/[0.1] bg-white/[0.03] px-2 py-1.5 text-sm outline-none focus:border-orange-500/60";
  const btn = "rounded-sm px-3 py-1.5 text-sm disabled:opacity-40";
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <form
        role="dialog"
        aria-label="설정"
        className="w-full max-w-md rounded-md border border-white/[0.08] bg-background p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">설정</h2>
          <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" title="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <label className="mb-3 block text-xs text-white/50">
          MCP 서버 주소
          <input className={cn(field, "mt-1")} type="url" required placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="mb-3 block text-xs text-white/50">
          토큰
          <input
            className={cn(field, "mt-1")}
            type="password"
            autoComplete="off"
            placeholder={config?.has_token ? "저장됨 · 바꿀 때만 입력" : "관리자에게 받은 토큰"}
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
          <button type="button" className={cn(btn, "border border-white/[0.1] text-white/70 hover:bg-white/10 hover:text-white")} disabled={busy || !url.trim()} onClick={test}>
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
