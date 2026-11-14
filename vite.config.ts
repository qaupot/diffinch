import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { host: "127.0.0.1", port: 42967, strictPort: true },
  build: { target: ["es2022", "safari16"] },
});
