import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createPlatformDevProxy } from '@codex/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    proxy: createPlatformDevProxy(),
  },
  plugins: [react()],
})
