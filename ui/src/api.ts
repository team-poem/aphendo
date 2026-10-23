// The Tauri webview serves the UI from its own origin; the browser and Vite dev share /api.
export const API =
  location.protocol === "tauri:" || location.hostname === "tauri.localhost" ? "http://127.0.0.1:47321" : "";
