# Theme palette acknowledgments

Linco's built-in themes adapt palette values from these projects. They do not
bundle the VS Code or Neovim extensions, icon packs, or executable extension code.

- GitHub Dark Default: https://github.com/primer/github-vscode-theme (MIT, Copyright 2020 Primer). See `github-dark.LICENSE`.
- Tokyo Night: https://github.com/folke/tokyonight.nvim (Apache-2.0). See `tokyo-night.LICENSE`.
- Catppuccin Mocha: https://github.com/catppuccin/palette (MIT, Copyright 2021 Catppuccin). See `catppuccin.LICENSE`.

Adapted 2026-09-08 in `src/lib/curatedThemes.ts`: workbench surface mappings,
button accents, selection colors, readable comments and muted text, CodeMirror
syntax roles, terminal ANSI colors, and semantic log highlights. Tokyo Night uses
the Night variant's background and the shared Storm accent palette. These are
Linco adaptations, not official ports or endorsements.

The expanded gallery adds 25 palettes from the collection also used by Ghostty.
See [gallery/README.md](gallery/README.md) for the pinned source revision,
individual family licenses, and adaptation details.

Monokai Pro is not bundled. Its proprietary extension and its separate Community
Edition conditions require a different distribution arrangement:
https://monokai.pro/license and https://monokai.pro/contribute.
