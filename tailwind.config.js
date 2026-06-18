/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 借鉴 Eigent 的中性浅色体系
        canvas: '#ffffff',
        sidebar: '#f6f6f4',
        ink: {
          DEFAULT: '#1a1a1a',
          muted: '#6b6b6b',
          faint: '#9a9a9a'
        },
        accent: '#d97a2b' // “完全访问” 橙色
      },
      fontFamily: {
        sans: [
          '-apple-system',
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
