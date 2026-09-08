import type { ComponentType, ReactNode, SVGProps } from 'react'
import {
  Archive, BookOpen, Braces, CirclePlay, Code2, Container, Database, File,
  FileText, FlaskConical, GitBranch, Image, LockKeyhole, Music2, NotebookPen,
  Package, Settings2, Sheet, TerminalSquare, Workflow,
} from 'lucide-react'
import './icons.css'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string }
type Tone = 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'purple' | 'red' | 'muted'

// Local SVGs: no icon font, network request, or dependency on file contents.
function glyph(children: ReactNode): ComponentType<IconProps> {
  return function Glyph({ size = 16, ...props }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>{children}</svg>
  }
}

function letters(label: string): ComponentType<IconProps> {
  return glyph(<text x="12" y="17" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize={label.length > 2 ? 11 : 15} fontWeight="750" letterSpacing="-0.7">{label}</text>)
}

const Python = glyph(<>
  <path fill="currentColor" stroke="none" d="M12 2c-4.7 0-5 1.7-5 3.5V7h6v1H5C2.8 8 2 10 2 12.5S3.1 17 5 17h1v-2.5C6 12.4 7.5 11 9.5 11H15c1.3 0 2-1 2-2V5.5C17 3.6 16 2 12 2Zm-2 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
  <path fill="currentColor" stroke="none" opacity=".8" d="M12 22c4.7 0 5-1.7 5-3.5V17h-6v-1h8c2.2 0 3-2 3-4.5S20.9 7 19 7h-1v2.5c0 2.1-1.5 3.5-3.5 3.5H9c-1.3 0-2 1-2 2v3.5c0 1.9 1 3.5 5 3.5Zm2-2a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
</>)
const Markdown = glyph(<path strokeWidth="2.2" d="M2.5 18V6l5 6 5-6v12M18.5 6v12m-3-3 3 3 3-3" />)
const ReactLogo = glyph(<>
  <ellipse cx="12" cy="12" rx="10" ry="4" />
  <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
  <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
  <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
</>)
const Git = glyph(<>
  <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" transform="rotate(45 12 12)" />
  <path d="m7 7 8 8M10 10v7" /><circle cx="10" cy="10" r="1.2" fill="currentColor" /><circle cx="10" cy="17" r="1.2" fill="currentColor" /><circle cx="15" cy="15" r="1.2" fill="currentColor" />
</>)
const Vue = glyph(<><path d="m2 5 10 16L22 5h-6l-4 7-4-7Z" /><path d="m8 5 4 7 4-7" /></>)
const Stylesheet = glyph(<path d="M7 3 5 21M17 3l-2 18M2 9h20M1 15h20" />)

function colored(kind: string, tone: Tone, Shape: ComponentType<IconProps>): ComponentType<IconProps> {
  function FileIcon({ className = '', size = 16, ...props }: IconProps) {
    return <Shape {...props} size={size} className={`file-type-icon file-icon-${tone} ${className}`} data-file-icon={kind} aria-hidden="true" focusable="false" />
  }
  FileIcon.displayName = `${kind}FileIcon`
  return FileIcon
}

const icons = {
  python: colored('python', 'teal', Python),
  html: colored('html', 'orange', Code2),
  markdown: colored('markdown', 'blue', Markdown),
  javascript: colored('javascript', 'amber', letters('JS')),
  typescript: colored('typescript', 'blue', letters('TS')),
  react: colored('react', 'teal', ReactLogo),
  css: colored('css', 'purple', Stylesheet),
  vue: colored('vue', 'green', Vue),
  svelte: colored('svelte', 'orange', letters('S')),
  rust: colored('rust', 'orange', letters('R')),
  go: colored('go', 'teal', letters('GO')),
  java: colored('java', 'red', letters('J')),
  c: colored('c', 'blue', letters('C')),
  cpp: colored('cpp', 'blue', letters('C++')),
  csharp: colored('csharp', 'purple', letters('C#')),
  swift: colored('swift', 'orange', letters('Sw')),
  json: colored('json', 'amber', Braces),
  config: colored('config', 'muted', Settings2),
  git: colored('git', 'red', Git),
  shell: colored('shell', 'green', TerminalSquare),
  notebook: colored('notebook', 'orange', NotebookPen),
  tex: colored('tex', 'green', letters('TeX')),
  bibliography: colored('bibliography', 'green', BookOpen),
  image: colored('image', 'purple', Image),
  spreadsheet: colored('spreadsheet', 'green', Sheet),
  database: colored('database', 'amber', Database),
  pdf: colored('pdf', 'red', letters('PDF')),
  archive: colored('archive', 'amber', Archive),
  audio: colored('audio', 'purple', Music2),
  video: colored('video', 'purple', CirclePlay),
  docker: colored('docker', 'blue', Container),
  package: colored('package', 'green', Package),
  lock: colored('lock', 'amber', LockKeyhole),
  text: colored('text', 'muted', FileText),
  code: colored('code', 'blue', Code2),
  file: colored('file', 'muted', File),
}

export type FileIconKind = keyof typeof icons
const extensions: Record<string, FileIconKind> = {}
function mapExtensions(kind: FileIconKind, names: string): void {
  for (const name of names.split(' ')) extensions[name] = kind
}
mapExtensions('python', 'py pyw pyi pyc pyo')
mapExtensions('html', 'html htm xhtml')
mapExtensions('markdown', 'md markdown mdx mdown')
mapExtensions('javascript', 'js mjs cjs')
mapExtensions('typescript', 'ts mts cts')
mapExtensions('react', 'jsx tsx')
mapExtensions('css', 'css scss sass less')
mapExtensions('vue', 'vue')
mapExtensions('svelte', 'svelte')
mapExtensions('rust', 'rs')
mapExtensions('go', 'go')
mapExtensions('java', 'java jar')
mapExtensions('c', 'c h')
mapExtensions('cpp', 'cpp cc cxx hpp hxx')
mapExtensions('csharp', 'cs')
mapExtensions('swift', 'swift')
mapExtensions('json', 'json jsonc json5 jsonl ndjson')
mapExtensions('config', 'yaml yml toml ini conf cfg env properties')
mapExtensions('shell', 'sh bash zsh fish ps1 psm1 bat cmd')
mapExtensions('notebook', 'ipynb')
mapExtensions('tex', 'tex sty cls')
mapExtensions('bibliography', 'bib')
mapExtensions('image', 'png jpg jpeg gif svg webp avif ico bmp tif tiff heic')
mapExtensions('spreadsheet', 'csv tsv xls xlsx ods parquet')
mapExtensions('database', 'sql db sqlite sqlite3 h5 hdf5')
mapExtensions('pdf', 'pdf')
mapExtensions('archive', 'zip tar gz bz2 xz zst 7z rar')
mapExtensions('audio', 'mp3 wav ogg flac m4a aac')
mapExtensions('video', 'mp4 webm mov mkv avi')
mapExtensions('lock', 'lock')
mapExtensions('text', 'txt log rst rtf')
mapExtensions('code', 'r jl rb php lua pl ex exs kt kts dart m')

// Names take precedence over extensions (e.g. .env.local and package.json).
const filenames: Record<string, FileIconKind> = {
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  '.editorconfig': 'config', '.npmrc': 'config', '.prettierrc': 'config', '.eslintrc': 'config',
  'package.json': 'package', 'package-lock.json': 'lock', 'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock', 'bun.lockb': 'lock', 'cargo.lock': 'lock', 'uv.lock': 'lock', 'poetry.lock': 'lock',
  'pyproject.toml': 'python', 'pipfile': 'python', 'pipfile.lock': 'lock',
  'cargo.toml': 'rust', 'go.mod': 'go', 'go.sum': 'lock',
  'makefile': 'shell', 'gnumakefile': 'shell', 'justfile': 'shell',
  'dockerfile': 'docker', 'containerfile': 'docker', '.dockerignore': 'docker',
  'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  'readme': 'markdown', 'license': 'text', 'licence': 'text',
}

function basename(name: string): string {
  return name.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()?.toLowerCase() || ''
}

export function fileIconKind(name: string): FileIconKind {
  const base = basename(name)
  if (Object.hasOwn(filenames, base)) return filenames[base]
  if (base.startsWith('.env.') || base === '.env') return 'config'
  if (/^(dockerfile|containerfile)\./.test(base)) return 'docker'
  if (/^requirements(?:[._-].+)?\.txt$/.test(base)) return 'python'
  if (/^tsconfig(?:\..+)?\.json$/.test(base)) return 'typescript'
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1) : ''
  return Object.hasOwn(extensions, ext) ? extensions[ext] : 'file'
}

// Stable component identity for tree rows, search results, and Git changes.
export function iconForFile(name: string): ComponentType<IconProps> {
  return icons[fileIconKind(name)]
}

export function FileTypeIcon({ name, ...props }: IconProps & { name: string }): JSX.Element {
  const Icon = iconForFile(name)
  return <Icon {...props} />
}

const folders = {
  source: { tone: 'blue', Badge: Code2 },
  scripts: { tone: 'teal', Badge: TerminalSquare },
  tests: { tone: 'green', Badge: FlaskConical },
  experiments: { tone: 'orange', Badge: FlaskConical },
  docs: { tone: 'blue', Badge: BookOpen },
  data: { tone: 'amber', Badge: Database },
  images: { tone: 'purple', Badge: Image },
  config: { tone: 'muted', Badge: Settings2 },
  git: { tone: 'red', Badge: GitBranch },
  github: { tone: 'purple', Badge: Workflow },
  packages: { tone: 'green', Badge: Package },
  notebooks: { tone: 'orange', Badge: NotebookPen },
  folder: { tone: 'muted', Badge: null },
} satisfies Record<string, { tone: Tone; Badge: ComponentType<IconProps> | null }>

type FolderIconKind = keyof typeof folders
const folderNames: Record<string, FolderIconKind> = {
  src: 'source', source: 'source', lib: 'source', components: 'source',
  scripts: 'scripts', bin: 'scripts', tools: 'scripts',
  test: 'tests', tests: 'tests', unit: 'tests', __tests__: 'tests', e2e: 'tests',
  experiment: 'experiments', experiments: 'experiments', runs: 'experiments',
  docs: 'docs', doc: 'docs', papers: 'docs', research: 'docs',
  data: 'data', datasets: 'data', results: 'data', checkpoints: 'data',
  images: 'images', assets: 'images', figures: 'images', screenshots: 'images',
  config: 'config', configs: 'config', '.vscode': 'config', '.codex': 'config',
  '.git': 'git', '.github': 'github', workflows: 'github',
  node_modules: 'packages', packages: 'packages', vendor: 'packages', notebooks: 'notebooks',
}

export function folderIconKind(name: string): FolderIconKind {
  const base = basename(name)
  return Object.hasOwn(folderNames, base) ? folderNames[base] : 'folder'
}

export function FolderTypeIcon({ name, open = false, size = 16, className = '', ...props }: IconProps & { name: string; open?: boolean }): JSX.Element {
  const kind = folderIconKind(name)
  const { tone, Badge } = folders[kind]
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`file-folder-icon ${className}`} data-folder-icon={kind} data-folder-open={open} aria-hidden="true" focusable="false">
    <path d={Badge ? 'M11 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v1' : 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z'} />
    {open && <path d={Badge ? 'm3 19 3-8h15' : 'm3 19 3-8h16l-3 9'} />}
    {Badge && <Badge x={12} y={11} width={12} height={12} strokeWidth={2} className={`file-type-icon file-icon-${tone}`} />}
  </svg>
}
