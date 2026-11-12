// The Tauri webview serves the UI from its own origin; the browser and Vite dev share /api.
export const API =
  location.protocol === "tauri:" || location.hostname === "tauri.localhost" ? "http://127.0.0.1:47321" : "";

export type CaptureStatus = { kind: "queued" } | { kind: "running" } | { kind: "done"; added: number; held?: number } | { kind: "failed"; error: string };
export type Capture = { id: string; image: string; status: CaptureStatus; created_at: string };
export const imageUrl = (id: string) => `${API}/api/captures/${id}/image`;
