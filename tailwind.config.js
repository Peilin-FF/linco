/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 颜色全部走 CSS 变量,主题切换时改 :root 变量值即可(见 src/lib/theme.ts)。
        // fallback 沿用原浅色值,防止变量未注入时(首帧)闪烁。
        canvas: 'var(--canvas, #ffffff)',
        sidebar: 'var(--sidebar, #f6f6f4)',
        ink: {
          DEFAULT: 'var(--ink, #1a1a1a)',
          muted: 'var(--ink-muted, #6b6b6b)',
          faint: 'var(--ink-faint, #9a9a9a)'
        },
        accent: 'var(--accent, #d97a2b)'
      },
      fontFamily: {
        // 用户可选字体经 --app-font 注入;为空时整条 var() 回退到后面的系统字体链。
        // 注意:var() 必须带 fallback,否则 --app-font 未定义会让整条 font-family 失效。
        sans: [
          'var(--app-font, -apple-system)',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Segoe UI',
          'sans-serif'
        ],
        serif: ['"Songti SC"', '"STSong"', 'Georgia', 'serif']
      },
      boxShadow: {
        card: '0 4px 24px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)'
      }
    }
  },
  plugins: []
}
