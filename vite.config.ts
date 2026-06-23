import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Tauri 期望固定端口的开发服务器
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  // 防止 vite 屏蔽 Rust 报错
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 不监听 src-tauri,避免 Rust 编译触发前端刷新
      ignored: ['**/src-tauri/**']
    }
  }
})