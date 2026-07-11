# lolly-tools

Community-safe tool definitions for [Lolly](https://github.com/lolly-tools/lolly) —
the constraint-first, template-driven creative-asset platform. Consumed by the
`lolly` monorepo as a git submodule at `community/`, and merged into the active
profile's `tools/` view alongside a brand pack (see the monorepo's `profiles.json`).

These tools are **brand-agnostic**: they declare no catalog asset dependencies,
so they run against any brand pack (SUSE, the blank `lolly-start` brand, or your
own). Each tool is a directory of *data, not code*:

```
<id>/
├── tool.json        # manifest (inputs, render config, examples)
├── template.html    # Handlebars markup (logic-less)
├── styles.css       # optional, auto-scoped
├── hooks.js         # optional imperative escape hatch
├── icon.svg         # gallery icon (Lucide house style)
└── card.svg|html    # optional authored gallery preview
```

## The tools

| Tool | What it does |
|---|---|
| `qr-code` | QR code generator (SVG/PNG, custom colors, joined modules) |
| `mesh-gradient` | Mesh-style gradients from brand swatches — draggable colour points, grain, drift animation |
| `street-map` | Vector street-map posters from OSM data |
| `color-palette` | Browse the active brand palette, click-to-copy |
| `compress-pdf` | On-device PDF compression |
| `strip-data` | Strip hidden metadata from images, on-device |
| `text-helper` | Text transforms and helpers |
| `countdown-timer` | Countdown timer graphics |
| `url-shot` | Rasterise a live URL (requires the `capture` capability) |
| `filter-duotone` | Duotone photo filter |
| `filter-halftone` | Halftone photo filter |
| `filter-pixel-stretch` | Pixel-stretch photo filter |
| `filter-posterize` | Posterize photo filter |
| `filter-scanline` | Scanline photo filter |
| `filter-voronoi` | Voronoi photo filter |

Tool `id`s are permanent contracts — never renamed or reused.

Split out of [`lolly-suse-tools`](https://github.com/lolly-tools/lolly-suse-tools)
(2026-07-08); SUSE-specific tools moved to the private `suse-lolly` brand pack.

## License

MPL-2.0 (see `LICENSE`). Tool icons follow the Lucide house style (ISC — see
`NOTICE.md`).
