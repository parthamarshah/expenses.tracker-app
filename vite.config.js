import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // Split vendor libs into separate cached chunks.
        // On repeat visits, only the app chunk re-downloads (vendors stay cached).
        manualChunks: {
          "vendor-react":   ["react", "react-dom"],
          "vendor-supabase": ["@supabase/supabase-js"],
          // exceljs is already code-split by the dynamic import in doExportXLSX
        },
      },
    },
  },
})