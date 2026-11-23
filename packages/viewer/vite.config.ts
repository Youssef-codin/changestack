import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    // The CLI serves the API; run `changestack <pr> --port 4317` alongside `vite` in dev.
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
});
