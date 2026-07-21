import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-v1-7-${Date.now()}.js`,
        chunkFileNames: `assets/[name]-v1-7-${Date.now()}.js`,
        assetFileNames: `assets/[name]-v1-7-${Date.now()}[extname]`
      }
    }
  }
})
