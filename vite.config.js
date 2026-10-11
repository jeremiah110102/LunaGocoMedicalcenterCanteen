import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    // The Supabase backend tests need a Postgres server (see tests/backends/supabase.e2e.test.js)
    exclude: ['**/node_modules/**', ...(process.env.PG_TEST_HOST ? [] : ['tests/backends/supabase.e2e.test.js'])],
  },
});
