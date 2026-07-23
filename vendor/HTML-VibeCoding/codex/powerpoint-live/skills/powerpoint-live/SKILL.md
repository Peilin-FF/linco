---
name: powerpoint-live
description: Create, redraw, inspect, or revise editable diagrams step by step in a visible Microsoft PowerPoint slide. Use when the user wants to draw directly in PowerPoint or requests an editable .pptx deliverable.
---

# PowerPoint Live

Use the MCP tools named `powerpoint_live_launch`, `powerpoint_live_add_shape`,
`powerpoint_live_add_text`, `powerpoint_live_add_connector`,
`powerpoint_live_connect_shapes`, `powerpoint_live_add_image`,
`powerpoint_live_group`, `powerpoint_live_align`,
`powerpoint_live_distribute`, `powerpoint_live_z_order`,
`powerpoint_live_duplicate`, `powerpoint_live_update`,
`powerpoint_live_draw_sequence`, `powerpoint_live_inspect`,
`powerpoint_live_export_preview`, `powerpoint_live_compare_reference`, and
`powerpoint_live_save`.

## Rules

- Draw in the visible PowerPoint window. Do not generate a complete PPTX invisibly and open it afterward.
- When revising an existing file, call `powerpoint_live_launch` with its exact path and slide index. It attaches to the matching presentation already open in PowerPoint; continue editing that same slide and window.
- Never create another presentation, append a slide, clear the current slide, or redraw the whole page during a local revision unless the user explicitly requests that operation.
- Use native PowerPoint shapes, text boxes, connectors, and pictures so every object remains editable.
- Use stable, descriptive object names. Never rely only on collection indices.
- Work in logical sections. Export a PNG after each section and inspect both the image and object geometry.
- New scientific figures use the `academic-wide` canvas by default: 182 x 115 mm (516 x 326 pt), matching common two-column paper artwork width. Use `academic-tall` only when the requested layout needs more vertical depth.
- Treat slide coordinates as points. Design at final print size; use 5-8 pt labels and 0.5-1 pt strokes unless the user requests another publication style.
- Keep important text inside its shape bounds and check for unintended overlaps.
- `powerpoint_live_inspect` must report `layout_warning_count=0` before saving.
- Save only after visual and geometry review. Do not overwrite an existing file unless the user explicitly requested it.

## Workflow

1. Call `powerpoint_live_launch` with the exact target `.pptx` path, target slide index, `canvas_preset: academic-wide`, and a visible 150-250 ms step delay. Reuse the attached open presentation when it exists.
2. Clear the slide only when rebuilding it intentionally.
3. Add native objects individually or with a paced `powerpoint_live_draw_sequence`.
4. Call `powerpoint_live_inspect` after each logical section.
5. Call `powerpoint_live_compare_reference` when a reference image exists. Otherwise call `powerpoint_live_export_preview`; inspect the PNG and correct layout issues.
6. Call `powerpoint_live_save` after the slide is complete.

PowerPoint desktop must be installed on Windows. Do not use mouse or keyboard automation.
