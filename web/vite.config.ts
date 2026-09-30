import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the API runs as a separate process.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
