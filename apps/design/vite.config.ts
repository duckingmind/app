import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: createPlatformDevProxy() },
})
