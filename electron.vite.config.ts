import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// KIEO-001 scaffold: electron-vite toolchain per user decision.
// Main + preload live in electron/, renderer root is repo root with index.html -> src/main.tsx.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: 'electron/main.ts'
      },
      rollupOptions: {
        // KIEO-061: optional peer — resolved at sign-in time, never bundled.
        // Absent package rejects at runtime into a typed not-installed error.
        external: ['@supabase/supabase-js']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: 'electron/preload.ts'
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: './index.html'
      }
    }
  }
})
