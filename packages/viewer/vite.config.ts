import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    // `changestack serve` provides the API; run it alongside `vite` in dev.
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
});
