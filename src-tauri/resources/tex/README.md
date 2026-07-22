# Bundled TinyTeX runtime

Linco bundles the platform-specific TinyTeX distribution so local LaTeX compilation works without a separate user download.

- Upstream: https://github.com/rstudio/tinytex-releases
- Pinned release: `v2026.05`
- Bundle: `TinyTeX` (community package set)
- License: GPL-2.0 and the licenses of the included TeX Live packages

Pinned archives:

- Windows: `TinyTeX-windows-v2026.05.exe` (`cfd2b2a39a023fbdd68f5637b12754936a3573c95d0b3fd46868d4bee8bc058b`)
- macOS: `TinyTeX-darwin-v2026.05.tar.xz` (`53f55f2ec100cc4e0ba5840f8a66086c6e37aa36b9aa4c64f924165352443e92`)

The archives are downloaded and SHA-256 verified by `scripts/prepare-tex-bundle.mjs` during the Tauri bundling phase. Generated archives are intentionally excluded from Git.
