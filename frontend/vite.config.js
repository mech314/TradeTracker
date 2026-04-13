import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "../static",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    }
  }
});