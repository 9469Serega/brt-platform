import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Замени 'brt-platform' на имя своего GitHub репозитория
  base: process.env.VITE_BASE_PATH || '/brt-platform/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: { port: 3000 }
})
