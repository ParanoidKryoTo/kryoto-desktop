import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import pkg from './package.json' with { type: 'json' }

/**
 * The web chat (chat.kryo.to): the same chat screens as the app, built as a
 * static site. `pnpm web:dev` / `pnpm web:build` (output: dist-web/).
 * VITE_KRYO_API and VITE_KRYO_GATEWAY point it at a local kryo.to and gateway.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  server: { port: 1422, strictPort: true, open: '/web.html', watch: { ignored: ['**/src-tauri/**', '**/target/**'] } },
  build: {
    outDir: 'dist-web',
    target: ['chrome105', 'safari15', 'firefox115'],
    sourcemap: false,
    rollupOptions: { input: { index: fileURLToPath(new URL('./web.html', import.meta.url)) } },
  },
})
