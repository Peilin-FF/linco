import { defineConfig, mergeConfig } from 'vite'
import { resolve } from 'node:path'
import appConfig from '../vite.config'

// Separate build: no demo code, fake IPC, or marketing UI enters the desktop.
export default mergeConfig(appConfig, defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  base: './',
  plugins: [{
    name: 'demo-preview-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './components/ScreenView' && importer?.endsWith('/src/App.tsx')) return resolve(__dirname, 'Preview.tsx')
    },
  }],
  server: { port: 1432, host: '127.0.0.1', fs: { allow: [resolve(__dirname, '..')] } },
  build: { outDir: resolve(__dirname, '../node_modules/.cache/linco-site'), emptyOutDir: true },
}))
