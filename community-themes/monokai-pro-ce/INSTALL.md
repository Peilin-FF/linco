# Monokai Pro (Community Edition) for [Linco](https://github.com/Peilin-FF/linco)

## Installation instructions

Use Linco 1.0.7 or newer with the **Import theme** control.
This candidate is included in Linco's source repository, not published as a separate theme package.

1. Open **Settings → General → Theme → Import theme**.
2. Choose `monokai-pro-ce.json` from this package directory.
3. Linco validates the colors, saves a local copy, and activates **Monokai Pro (CE)**.

The editor, terminal and Linco interface update together. Importing does not restart
running agent sessions. It does not change Notion or an embedded page's own theme.

## Persistence and removal

The imported palette is stored in this device's desktop webview storage, separate
from Linco's built-in themes. The selected theme ID uses the normal saved app
configuration. It remains available after restarting that desktop installation,
but is not automatically synchronized to another device or a browser preview.

Select another theme to switch back. **Remove local copy** removes the imported
palette; if it was active, Linco switches to its default light theme. The original
JSON file is untouched and can be imported again. Keep the JSON file as a backup:
clearing Linco's webview data removes locally imported palettes.

## Updates

Remove the existing local copy, then import the updated JSON. Imports never silently
overwrite an existing theme or a built-in palette. There are no registration bypasses,
extension installers, extra color filters or proprietary Monokai icons in this package.
