import { useMemo } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'

marked.setOptions({
  breaks: true,
  gfm: true
})

// 代码块高亮(marked 扩展)
marked.use({
  renderer: {
    code(this: unknown, token: { text: string; lang?: string }) {
      const lang = token.lang && hljs.getLanguage(token.lang) ? token.lang : ''
      const html = lang
        ? hljs.highlight(token.text, { language: lang }).value
        : escapeHtml(token.text)
      return `<pre class="hljs-pre"><code class="hljs">${html}</code></pre>`
    }
  }
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface MarkdownProps {
  text: string
}

export default function Markdown({ text }: MarkdownProps): JSX.Element {
  const html = useMemo(() => marked.parse(text) as string, [text])
  return (
    <div
      className="linco-md text-[14px] leading-relaxed text-ink"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
