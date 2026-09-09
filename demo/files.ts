import previewSource from './Preview.tsx?raw'
import gardenSource from './garden.ts?raw'
import { readGarden } from './garden'

// One manifest drives both the tree and file reads; no generic content fallback.
// Source references are inspectable, not compiled from visitor edits.
export const demoFiles: Record<string, string> = {
  'README.md': `# Pocket Garden

A tiny interactive project inside the Linco playground.

## Make it yours
1. Open src/garden.json and change the title, night setting, or plant names.
2. Save, then return to Vibe Working → Live preview.
3. Water a plant three times to make it bloom.

## What these files do
- src/garden.json: live editable configuration.
- src/Preview.tsx and src/garden.ts: the actual demo renderer and state source,
  provided for inspection. They belong to the Linco demo build.
- scripts/, tests/, data/, and experiments/: small illustrative research examples.
- docs/architecture.md: how the playground works and its limits.

Only garden.json edits update the preview. Other edits stay in demo memory;
they are not compiled or executed. Reload resets files. Agent replies are scripted.
Download garden.json from the preview to keep your configuration.
`,
  '.gitignore': 'node_modules/\ndist/\n__pycache__/\n.pytest_cache/\n.env\n',
  'package.json': JSON.stringify({
    name: 'pocket-garden-demo', private: true,
    description: 'Illustrative workspace; renderer is built by the parent Linco demo, not this manifest.',
    type: 'module',
  }, null, 2) + '\n',
  'index.html': `<!doctype html>
<!-- Illustrative document shell. The public demo mounts its preview in React. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pocket Garden</title>
  </head>
  <body>
    <main id="root" aria-label="Pocket Garden"></main>
  </body>
</html>
`,
  'src/garden.json': '', // Read from current state, including scripted agent edits.
  'src/Preview.tsx': previewSource,
  'src/garden.ts': gardenSource,
  'scripts/train.py': `"""Illustrative deterministic growth baseline; no training runs in the browser."""
import csv
from pathlib import Path

def run_experiment():
    rows = []
    for clicks in range(5):
        growth = min(clicks, 3)
        rows.append({"clicks": clicks, "growth": growth, "bloomed": growth == 3})
    output = Path("data/results.csv")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["clicks", "growth", "bloomed"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"Recorded {len(rows)} deterministic observations in {output}")

if __name__ == "__main__":
    run_experiment()
`,
  'scripts/evaluate.py': `"""Check the illustrative CSV against the three-click growth rule."""
import csv
from pathlib import Path

with Path("data/results.csv").open(newline="") as stream:
    rows = list(csv.DictReader(stream))
assert rows, "Expected at least one observation"
for row in rows:
    expected = min(int(row["clicks"]), 3)
    assert int(row["growth"]) == expected
    assert row["bloomed"] == str(expected == 3)
print(f"PASS: {len(rows)} rows match the growth rule")
`,
  'scripts/run.sh': '#!/usr/bin/env bash\n# Example local workflow; the browser demo does not execute commands.\nset -euo pipefail\npython scripts/train.py\npython scripts/evaluate.py\npython -m unittest discover -s tests\n',
  'tests/test_garden.py': `"""Example specification of the growth rule, not a browser integration test."""
import unittest

def growth_after(clicks):
    return min(max(clicks, 0), 3)

class GardenGrowthTests(unittest.TestCase):
    def test_new_plant_starts_at_zero(self):
        self.assertEqual(growth_after(0), 0)

    def test_third_click_blooms(self):
        self.assertEqual(growth_after(3), 3)

    def test_growth_stops_at_three(self):
        self.assertEqual(growth_after(10), 3)

if __name__ == "__main__":
    unittest.main()
`,
  'data/results.csv': 'clicks,growth,bloomed\n0,0,False\n1,1,False\n2,2,False\n3,3,True\n4,3,True\n',
  'data/events.jsonl': [
    { event: 'plant_added', plant: 'Basil', clicks: 0 },
    { event: 'plant_watered', plant: 'Basil', clicks: 1 },
    { event: 'plant_bloomed', plant: 'Basil', clicks: 3 },
  ].map(event => JSON.stringify(event)).join('\n') + '\n',
  'experiments/conclusions.md': `# Growth interaction — example research record

Status: illustrative specification, not a user study.

## Question
Can a visitor understand the edit → save → preview loop through a tiny garden?

## Proposed protocol
- Ask a visitor to rename the garden using src/garden.json.
- Ask them to make one plant bloom without instructions.
- Record completion and confusion separately; do not infer satisfaction from clicks.

## Current evidence
data/results.csv contains synthetic examples of the three-click rule.
It is not evidence of usability or real research performance.

## Next step
Observe actual visitors, note where they hesitate, and revise the instructions.
`,
  'docs/architecture.md': `# How this playground works

## Editable state
src/garden.json → validation → in-memory garden → React live preview.
Invalid JSON is kept in the editor; the preview retains its last valid state.

## Source references
src/Preview.tsx and src/garden.ts are copied directly from this demo's source
at build time. Preview imports React and Lucide icons from the parent project.
The displayed files are references, not a standalone package or runtime compiler.

## Boundaries
The surrounding workspace uses Linco's actual React components with mocked IPC.
No Rust desktop backend, SSH connection, shell process, or AI request is started.
Only configuration edits affect the preview. All file edits reset on reload.
The sample Python scripts, tests, and data are illustrative and never executed here.
`,
}

export function listDemoFiles(directory: string): string[] {
  const prefix = directory ? `${directory}/` : ''
  return [...new Set(Object.keys(demoFiles).filter(path => path.startsWith(prefix)).map(path => {
    const rest = path.slice(prefix.length)
    return rest.includes('/') ? `${rest.split('/')[0]}/` : rest
  }))]
}

export function readDemoFile(path: string): string {
  if (!Object.hasOwn(demoFiles, path)) throw new Error(`File not found in the demo: ${path}`)
  return path === 'src/garden.json' ? JSON.stringify(readGarden(), null, 2) + '\n' : demoFiles[path]
}
