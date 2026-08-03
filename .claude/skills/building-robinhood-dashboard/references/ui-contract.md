# Exact UI contract

## Contents

- Authority and permitted changes
- Required structure
- Required interactions
- Responsive and accessibility behavior
- U.S. substitutions

## Authority and permitted changes

`assets/index.html` is the canonical implementation. Copy it; do not imitate it. The only permitted product-level substitutions are dynamic portfolio values, USD formatting, ticker identifiers, U.S. benchmark names, Robinhood/Yahoo source language, and authentication/session controls.

Do not replace the design with Ravenhood, Tailwind, Chart.js, a component library, or generic dashboard cards. Do not remove a section because its data is unavailable.

## Required structure

Keep these `main` sections in exactly this order:

1. `overview`
2. `benchmarks`
3. `heatmap`
4. `xirr`
5. `allocation`
6. `valuation`
7. `categories`
8. `funds`
9. `holdings`
10. `risk`
11. `board`
12. `range`
13. `activity`
14. `gains`
15. `composition`

Keep the sticky header, primary navigation, More disclosure menu, hero, KPI grid, snapshot cards, card/grid primitives, tables, tooltip, backdrop, and right-side modal drawer.

Keep the original CSS variable families: backgrounds, cards, borders, text, muted text, gold, gain, loss, equity blue, ETF purple, shadow, radius, and glow. Preserve dark and light themes.

## Required interactions

- Theme toggle with browser-local persistence.
- Active-section navigation using intersection observation.
- Heatmap tabs for day move, total return, XIRR, and weight.
- Keyboard/touch-selectable heatmap tiles with a persistent selection summary.
- Holdings search, asset/gain/loss/term filters, detail-column toggle, and sortable headers.
- ETF and holdings rows opening the same holding dossier.
- Winner/loser absolute and percent modes.
- Buy/sell transaction filters and corporate-action filters.
- Drawer backdrop close, close button, Escape close, focus trap, and focus restoration.
- Refresh and logout controls styled as subordinate header actions.

## Responsive and accessibility behavior

- Preserve the 940 px, 760 px, and 620 px breakpoint behavior.
- Keep real horizontal table overflow on narrow screens.
- Keep focus-visible controls, `aria-pressed`, `aria-sort`, `role="dialog"`, `aria-modal="true"`, `aria-hidden`, live regions, and keyboard row activation.
- Avoid hover-only meaning. Tooltips supplement visible values.
- Never hide core portfolio value, day movement, holding name/ticker, current value, weight, XIRR, or unrealized gain on mobile.

## U.S. substitutions

- Format currency as USD with `en-US` number formatting.
- Use ticker symbols where the source dashboard used security identifiers.
- Use SPY and QQQ as the two benchmark instruments.
- Classify Robinhood `etp`/ETF/fund instruments as `ETF` and label them “ETF” everywhere visible.
- Show account-wide filled stock activity instead of an Indian fiscal-year slice.
- Show authoritative realized gains as unavailable unless an explicit authoritative broker tax source is added.
