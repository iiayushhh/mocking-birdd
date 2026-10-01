import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// standard Vite + React setup, nothing fancy
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
