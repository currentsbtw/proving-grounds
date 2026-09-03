import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { JUDGE_PORT } from './src/domain/judge.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The advisory judge runs as a local proxy (`npm run judge`) so the browser
    // never holds an API key.
    proxy: { '/api': `http://localhost:${JUDGE_PORT}` },
  },
})
