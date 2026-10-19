import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createPlatformDevProxy } from '../../proxy-app-sdk/src/vite.ts'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@ducking-mind/proxy-app-sdk': new URL('../../proxy-app-sdk/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: createPlatformDevProxy(),
  },
})
