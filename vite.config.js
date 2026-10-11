import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Required for GitHub Pages repository deployment
  base: "/LunaGocoMedicalcenterCanteen/",

  build: {
    chunkSizeWarningLimit: 1200,
  },

  test: {
    environment: "node",
    // Skip Supabase backend tests unless PG_TEST_HOST is configured
    exclude: [
      "**/node_modules/**",
      ...(process.env.PG_TEST_HOST
        ? []
        : ["tests/backends/supabase.e2e.test.js"]),
    ],
  },
});
