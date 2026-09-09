import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split vendor libraries into their own chunks, separate from app
        // code. App code changes on every deploy (new hash -> re-download),
        // but these vendor libs rarely change -> the browser keeps serving
        // them from cache across app updates instead of re-downloading
        // React/Firebase every time a page gets tweaked.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("firebase")) return "firebase-vendor";
          if (id.includes("react-router")) return "router-vendor";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
        },
      },
    },
  },
})
