# Vibeship brand assets

Container-boat mark: ink `#111111`, signal orange `#e85d04`, cream `#f3eee4`. Wordmark: JetBrains Mono Medium (OFL), outlined to paths. Regenerate everything with `python3 gen_brand.py` (needs `resvg-py`, `fonttools` and `pillow`, plus JetBrains Mono at /workspace/fonts).

| File | Use |
|---|---|
| vibeship-mark.svg / @1x,@2x,@4x.png | Icon only, transparent background |
| vibeship-mark-mono.svg | Ink only, no orange |
| vibeship-mark-inverse.svg | For dark backgrounds: cream strokes, orange sail |
| vibeship-logo-horizontal.svg / @1x,@2x,@4x.png | Icon + wordmark |
| vibeship-logo-horizontal-inverse.svg | Horizontal logo for dark backgrounds |
| vibeship-logo-stacked.svg | Icon above wordmark |
| vibeship-wordmark.svg | Wordmark only |
| favicon.svg, favicon.ico (16/32/48), favicon-16.png, favicon-32.png | Simplified mark on a cream rounded tile |
| apple-touch-icon.png | 180px, cream background |
| icon-192.png, icon-512.png | PWA icons, transparent |
| icon-512-maskable.png | Maskable icon (20% safe padding, cream) |
| og-image.png / .svg | 1200x630 social card |
| site.webmanifest | Web manifest |
| preview.png | Contact sheet |

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#f3eee4">
<meta property="og:title" content="Vibeship">
<meta property="og:description" content="ship it to your own box">
<meta property="og:image" content="https://vibeship.hiranyey.dev/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
```
