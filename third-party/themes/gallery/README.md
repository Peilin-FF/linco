# Built-in theme gallery provenance

Linco includes a curated, offline subset of the color collection used by
[Ghostty](https://ghostty.org/docs/features/theme). It does not bundle Ghostty,
execute theme configuration, or fetch themes at runtime.

Source: [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes),
revision `752a9c079396cc9939b86e893578ed81e80c140f`, directory `ghostty/`.
`src/lib/data/terminalThemeCatalog.json` records each original filename in
`sourceName`. The collection license is reproduced in `collection.LICENSE`;
individual theme copyrights and licenses also apply.

| Family | Included variants | Upstream / license |
| --- | --- | --- |
| Catppuccin | Frappe, Latte, Macchiato | [Catppuccin](https://github.com/catppuccin/palette), MIT, `../catppuccin.LICENSE` |
| Tokyo Night | Day, Moon, Storm | [Tokyo Night](https://github.com/folke/tokyonight.nvim), Apache-2.0, `../tokyo-night.LICENSE` |
| Rosé Pine | Main, Dawn, Moon | [Rosé Pine](https://github.com/rose-pine/ghostty), MIT, `rose-pine.LICENSE` |
| Everforest | Dark/Light × Hard/Medium/Soft | [Everforest](https://github.com/sainnhe/everforest), MIT, `everforest.LICENSE` |
| Nord | Nord | [Nord](https://github.com/nordtheme/nord), MIT, `nord.LICENSE` |
| Dracula | Dracula | [Dracula](https://github.com/dracula/ghostty), MIT, `dracula.LICENSE` |
| Ayu | Dark, Light, Mirage | [Ayu](https://github.com/ayu-theme/ayu-colors), MIT, `ayu.LICENSE` |
| Kanagawa | Dragon, Lotus, Wave | [Kanagawa](https://github.com/rebelot/kanagawa.nvim), MIT, `kanagawa.LICENSE` |
| Solarized | Dark, Light | [Solarized](https://github.com/altercation/solarized), MIT, `solarized.LICENSE` |

Adapted for Linco on 2026-09-08. The original backgrounds, cursors and 16 ANSI
colors are retained. Workbench surfaces, syntax roles and semantic log colors
are Linco mappings in `src/lib/themeCatalog.ts`, not upstream editor themes.
Text colors are adjusted where necessary for 4.5:1 contrast against the canvas;
selection backgrounds are blended and filled buttons use a white-text-safe
accent. Terminal ANSI colors remain unchanged, including subdued ANSI colors.
Existing saved theme IDs and legacy migrations remain unchanged; new IDs use
the `gallery-` prefix. No affiliation or endorsement is implied.

The seven earlier built-ins remain available. Monokai Pro is not part of this
catalog; the separate, locally importable Community Edition package is unchanged.
