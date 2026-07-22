---
name: drawio-live
description: Create, redraw, inspect, or revise diagrams step by step in Linco's visible draw.io canvas. Use whenever the user asks Codex to draw in Linco, wants to watch the drawing process, rejects XML-first generation, or requests an editable .drawio deliverable.
---

# Linco Draw.io Live

Use the MCP tools named `drawio_live_launch`, `drawio_live_status`,
`drawio_live_add_shape`, `drawio_live_add_edge`, `drawio_live_update_cell`,
`drawio_live_draw_sequence`, `drawio_live_fit`, `drawio_live_screenshot`,
`drawio_live_reference_image`, `drawio_live_compare_reference`,
`drawio_icon_search`, `drawio_icon_download`, `drawio_icon_import`,
`drawio_icon_import_generated`, `drawio_icon_daixia_handoff`,
`drawio_live_add_icon`, `drawio_live_inspect`, and
`drawio_live_save_snapshot`.

## Required behavior

- Draw only through the live MCP tools while the Linco Drawing tab is visible.
- Never generate a complete `.drawio` XML file and open it afterward as the drawing method.
- Do not use operating-system mouse, keyboard, or screen automation.
- Keep shapes, labels, connectors, and groups editable.
- Do not approximate recognizable icons with ad hoc circles and lines. Search for a suitable asset first.
- Use stable semantic cell IDs so later edges and corrections target exact elements.
- Apply a nonzero delay, normally 80-150 ms, so the user can see progress without making large diagrams unnecessarily slow.
- Save the `.drawio` snapshot only after the visible canvas is complete.

## Workflow

1. If the user supplied a reference image path, call `drawio_live_reference_image` and decompose the visible composition into editable primitives.
2. Call `drawio_live_launch` with the drawing path shown in Linco and a visible step delay.
3. Confirm readiness with `drawio_live_status`.
4. Add shapes and edges individually, or use a paced `drawio_live_draw_sequence` whose operations remain separate.
5. Fit after each logical section. Use `drawio_live_compare_reference` so the reference and current canvas appear in the same review result.
6. Call `drawio_live_inspect` and treat every `layout_warning` as unresolved. Check `visual_geometry`, not only raw geometry, especially for rotated cells.
7. Correct labels, topology, alignment, clipping, arrow direction, whitespace, and color consistency. Repeat compare and inspect until the composition is coherent and `layout_warning_count` is zero.
8. Call `drawio_live_save_snapshot` only after the user has watched the complete figure appear.

## Icon asset workflow

1. For icon-rich figures, use a project directory containing `diagram.drawio`, `assets/icons/`, `icons-manifest.json`, and `ATTRIBUTION.md`.
2. Before downloading anything, call `drawio_icon_search` with the intended visual style and enough previews to compare candidates. Use alternate semantic queries when needed. Never choose the first text result without inspecting its preview.
3. Prefer one coherent icon family for the whole figure. Compare silhouette, stroke weight, palette, viewpoint, and detail level against the reference image. Search another style or source when the candidates are visually weak.
4. Call `drawio_icon_download` only after selecting a preview. It stores the source SVG and records the collection, author, source URL, and license.
5. If open-source candidates are unsuitable, use web/image search to inspect Flaticon, Iconfont, Magnific, IconScout, or another reputable source. Ask for user approval before spending a paid download credit.
6. When the user has approved a specific asset and has a paid Daixia account, call `drawio_icon_daixia_handoff` to produce a browser handoff link. Do not submit it silently, automate login, or handle the user's cookies, tokens, or auto-login URL.
7. If searched assets remain unsuitable and the figure needs a small custom illustration rather than a standard UI symbol, use the installed `imagegen` skill and built-in image generation. Generate each distinct icon separately at 256-512 px with the same style specification and a flat removable chroma-key background. Remove the background and visually inspect every result before use.
8. Register generated assets with `drawio_icon_import_generated`, including the exact prompt and model when known. Do not claim that generated assets have an external stock license.
9. Add downloaded files through `drawio_icon_import` with the actual source URL and license, then insert downloaded or generated assets with `drawio_live_add_icon`. The draw.io cell embeds the image for portability while the original source remains in the project package.
10. Keep icons secondary to the editable scientific layout. Use raster icons only when an editable vector is unavailable.

If the bridge says the drawing view is unavailable, tell the user to open Linco's Drawing tab and retry. Do not silently fall back to XML-first file generation.
