# Linco TinyTeX supplement

This directory contains a small offline supplement for the TinyTeX v2026.05
runtime bundled with Linco. It covers packages commonly used by academic
Overleaf projects that are absent from the standard TinyTeX community bundle.

The files come from the TeX Live 2026 package repository. Package metadata,
including upstream paths, versions, checksums, and license identifiers, is kept
under `metadata/`. Linco copies only missing files into its private TinyTeX
runtime and runs `mktexlsr`; it does not overwrite packages installed by the
user.

Included packages: `algorithm2e`, `aliascnt`, `arydshln`, `bbding`, `changes`, `csvsimple`,
`ifoddpage`, `listingsutf8`, `lt3luabridge`, `lua-tinyyaml`, `markdown`, `nicematrix`, `relsize`,
`textpos`, `todonotes`, `truncate`, `was`, and `xurl`.

The research-paper additions use the unmodified TeX Live runfiles from
`https://mirrors.ctan.org/systems/texlive/tlnet/archive/` (retrieved 2026-09-09).
Archive SHA-256 fingerprints are recorded below. Original copyright and LPPL
license notices remain in the files; complete upstream sources and documentation
are available at [changes](https://ctan.org/pkg/changes),
[todonotes](https://ctan.org/pkg/todonotes), [truncate](https://ctan.org/pkg/truncate),
and [listingsutf8](https://ctan.org/pkg/listingsutf8).

| Archive | SHA-256 |
| --- | --- |
| changes.tar.xz | 53fd16ab77f7597c28ebe55c5590bf96da218410fe05ef0e2dbf1420ebe358e4 |
| todonotes.tar.xz | e737eada85b0cc55fc4fe49590480403ff4cd717ecffd057186afbee61a64092 |
| truncate.tar.xz | 9c358ffbfd4083267c6df81d8bedf53b3cede5c8cb89f0af1c41771fc27df46e |
| listingsutf8.tar.xz | 76e727804662263cc29bb0f06882291d2849cfe74761f93ae22bdb3f58ef13aa |

The macOS `markdown2tex` launcher is the upstream `markdown2tex.lua` script with
its original shebang and is marked executable when installed. The Windows
launcher is the upstream TeX Live wrapper.
