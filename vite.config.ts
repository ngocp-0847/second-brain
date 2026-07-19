import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "ui",
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "chrome110",
  },
});
