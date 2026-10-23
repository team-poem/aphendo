import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:47321" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { main: page("index.html"), overlay: page("overlay.html") } },
  },
});
