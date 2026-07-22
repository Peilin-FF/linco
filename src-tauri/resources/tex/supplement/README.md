# Linco TinyTeX supplement

This directory contains a small offline supplement for the TinyTeX v2026.05
runtime bundled with Linco. It covers packages commonly used by academic
Overleaf projects that are absent from the standard TinyTeX community bundle.

The files come from the TeX Live 2026 package repository. Package metadata,
including upstream paths, versions, checksums, and license identifiers, is kept
under `metadata/`. Linco copies only missing files into its private TinyTeX
runtime and runs `mktexlsr`; it does not overwrite packages installed by the
user.

Included packages: `algorithm2e`, `aliascnt`, `arydshln`, `bbding`, `csvsimple`,
`ifoddpage`, `lt3luabridge`, `lua-tinyyaml`, `markdown`, `nicematrix`, `relsize`,
`textpos`, `was`, and `xurl`.

The macOS `markdown2tex` launcher is the upstream `markdown2tex.lua` script with
its original shebang and is marked executable when installed. The Windows
launcher is the upstream TeX Live wrapper.
