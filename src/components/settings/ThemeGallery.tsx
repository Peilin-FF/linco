import { useMemo, useState } from 'react'
import { Search, Star, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { Theme } from '@/lib/theme'
import './themeGallery.css'

const FAVORITES_KEY = 'linco:theme-favorites:v1'
function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 100).slice(0, 250) : []
  } catch { return [] }
}
type Filter = 'all' | 'dark' | 'light' | 'favorites'
interface Props { themes: Theme[]; activeId: string; onPick: (id: string) => void; onRemove: (id: string) => void }

export default function ThemeGallery({ themes, activeId, onPick, onRemove }: Props): JSX.Element {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [favorites, setFavorites] = useState(readFavorites)
  const [saveError, setSaveError] = useState(false)
  const active = themes.find(theme => theme.id === activeId)
  const shown = useMemo(() => {
    const query = search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    return themes.filter(theme => {
      const text = `${theme.name} ${theme.family || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      return text.includes(query) && (filter === 'all' || filter === 'dark' && theme.dark || filter === 'light' && !theme.dark || filter === 'favorites' && favorites.includes(theme.id))
    })
  }, [themes, search, filter, favorites])
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id]
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); setFavorites(next); setSaveError(false) }
    catch { setSaveError(true) }
  }
  return <div className="theme-gallery" aria-label={t('settings.general.theme.gallery')}>
    <div className="theme-gallery-current">
      <span>{t('settings.general.theme.active')}: <strong>{active?.name}</strong></span>
      <span>{t('settings.general.theme.available', { n: themes.length })}</span>
    </div>
    <div className="theme-gallery-toolbar">
      <label className="theme-gallery-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label={t('settings.general.theme.search')} placeholder={t('settings.general.theme.search')} value={search} onChange={event => setSearch(event.target.value)} />
        {search && <button aria-label={t('settings.general.theme.clearSearch')} onClick={() => setSearch('')}><X size={13} /></button>}
      </label>
      <div className="theme-gallery-filters" role="group" aria-label={t('settings.general.theme.filter')}>
        {(['all', 'dark', 'light', 'favorites'] as const).map(item => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{t(`settings.general.theme.${item}`)}</button>)}
      </div>
    </div>
    <div className="theme-gallery-results" aria-live="polite">{t('settings.general.theme.results', { n: shown.length })}</div>
    {saveError && <p role="status" className="theme-gallery-empty">{t('settings.general.theme.favoritesError')}</p>}
    <div className="theme-gallery-scroll">
      {shown.length ? <div className="theme-gallery-grid">
        {shown.map(theme => <div className="theme-gallery-item" key={theme.id}>
          <button className="theme-card" aria-label={`${theme.name}${theme.id === activeId ? ` ${t('settings.general.theme.active')}` : ''}`} aria-pressed={theme.id === activeId} data-theme-option={theme.id} onClick={() => onPick(theme.id)}>
            <div className="theme-card-preview" style={{ background: theme.vars.canvas, color: theme.vars.ink }} aria-hidden="true">
              <div className="theme-card-mini-sidebar" style={{ background: theme.vars.sidebar, borderColor: theme.vars.border }}><span /><span /><span /></div>
              <div className="theme-card-sample">
                <div style={{ color: theme.syntax.comment }}># experiment.py</div>
                <div><span style={{ color: theme.syntax.keyword }}>def</span> <span style={{ color: theme.syntax.function }}>explore</span>():</div>
                <div>  seed = <span style={{ color: theme.syntax.number }}>42</span></div>
                <div>  <span style={{ color: theme.syntax.string }}>"Stay curious."</span></div>
                <div className="theme-card-swatches">{[theme.ansi?.red || theme.vars.error, theme.ansi?.green || theme.vars.diffAddedForeground, theme.ansi?.yellow || theme.vars.warning, theme.ansi?.blue || theme.vars.link, theme.ansi?.magenta || theme.syntax.keyword, theme.ansi?.cyan || theme.syntax.type].map((color, i) => <i key={i} style={{ background: color }} />)}</div>
              </div>
            </div>
            <div className="theme-card-caption"><span>{theme.name}</span><small>{theme.id === activeId ? t('settings.general.theme.active') : t(`settings.general.theme.${theme.dark ? 'dark' : 'light'}`)}</small></div>
          </button>
          <label className="theme-favorite" title={t('settings.general.theme.favoriteNamed', { name: theme.name })}>
            <input type="checkbox" aria-label={t('settings.general.theme.favoriteNamed', { name: theme.name })} checked={favorites.includes(theme.id)} onChange={() => toggleFavorite(theme.id)} />
            <Star size={13} aria-hidden="true" fill={favorites.includes(theme.id) ? 'currentColor' : 'none'} />
          </label>
          {theme.id.startsWith('imported:') && <button className="theme-gallery-remove" aria-label={t('settings.general.theme.removeNamed', { name: theme.name })} onClick={() => onRemove(theme.id)}>{t('settings.general.theme.remove')}</button>}
        </div>)}
      </div> : <div className="theme-gallery-empty"><p>{t('settings.general.theme.noResults')}</p><button onClick={() => { setSearch(''); setFilter('all') }}>{t('settings.general.theme.reset')}</button></div>}
    </div>
  </div>
}
