import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createPlatformDevProxy, createPlatformDevSessionPlugin } from '../../proxy-app-sdk/src/vite.ts'
import appManifest from './manifest.json' with { type: 'json' }

export default defineConfig({
  base: './',
  plugins: [
    react(),
    createPlatformDevSessionPlugin(),
    {
      name: 'pelican-task-runtime-artifact',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'runtime/task.mjs',
          source: readFileSync(new URL('./runtime/task.mjs', import.meta.url).pathname, 'utf8'),
        })
      },
    },
  ],
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
