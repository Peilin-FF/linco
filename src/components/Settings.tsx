import { useState } from 'react'
import {
  ArrowLeft,
  SlidersHorizontal,
  Code2,
  Server,
  Wand2,
  Network,
  Puzzle,
  TerminalSquare,
  ShieldCheck,
  BarChart3,
  Rocket,
  Cloud
} from 'lucide-react'
import type { AppConfig } from '@/lib/config'
import ModelSettings from './settings/ModelSettings'
import Connections from './settings/Connections'

type SectionId =
  | 'general'
  | 'preview'
  | 'model'
  | 'connections'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'commands'
  | 'index'
  | 'usage'

const NAV: { id: SectionId; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'general', label: '常规', icon: SlidersHorizontal },
  { id: 'preview', label: '代码预览', icon: Code2 },
  { id: 'model', label: '模型设置', icon: Server },
  { id: 'connections', label: '连接', icon: Cloud },
  { id: 'skills', label: '技能', icon: Wand2 },
  { id: 'mcp', label: 'MCP 服务器', icon: Network },
  { id: 'plugins', label: '插件管理', icon: Puzzle },
  { id: 'commands', label: '命令', icon: TerminalSquare },
  { id: 'index', label: '索引库', icon: ShieldCheck },
  { id: 'usage', label: '使用统计', icon: BarChart3 }
]

interface SettingsProps {
  config: AppConfig
  onChange: (config: AppConfig) => void
  onClose: () => void
}

export default function Settings({
  config,
  onChange,
  onClose
}: SettingsProps): JSX.Element {
  const [section, setSection] = useState<SectionId>('general')

  return (
    <div className="flex h-full w-full bg-sidebar font-sans text-ink">
      {/* 左侧导航 */}
      <aside className="drag flex w-[280px] shrink-0 flex-col px-3">
        <div className="h-12 shrink-0" />
        <button
          onClick={onClose}
          className="no-drag mb-3 flex items-center gap-2 px-2.5 py-1.5 text-[14px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={18} />
          <span>返回工作区</span>
        </button>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`no-drag flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] transition-colors ${
                id === section
                  ? 'bg-canvas text-ink shadow-sm'
                  : 'text-ink-muted hover:bg-black/5'
              }`}
            >
              <Icon size={18} className="shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <button className="no-drag mb-3 mt-2 flex items-center gap-3 rounded-xl border border-dashed border-black/15 px-3 py-2.5 text-[14px] text-ink-muted hover:bg-black/5">
          <Rocket size={18} className="shrink-0" />
          <span>引导</span>
        </button>
      </aside>

      {/* 右侧内容 */}
      <main className="flex-1 p-1.5 pl-0">
        <div className="h-full w-full overflow-y-auto rounded-2xl bg-canvas p-8 shadow-card">
          {section === 'model' ? (
            <ModelSettings config={config} onChange={onChange} />
          ) : section === 'connections' ? (
            <Connections config={config} onChange={onChange} />
          ) : (
            <SectionPlaceholder
              title={NAV.find((n) => n.id === section)?.label ?? ''}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function SectionPlaceholder({ title }: { title: string }): JSX.Element {
  return (
    <div>
      <h2 className="text-[20px] font-semibold text-ink">{title}</h2>
      <p className="mt-3 text-[14px] text-ink-faint">该模块待接入。</p>
    </div>
  )
}
