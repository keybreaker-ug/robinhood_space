---
name: building-robinhood-dashboard
description: Recreate, repair, or extend the canonical private Robinhood U.S. stocks and ETFs portfolio dashboard. Use when asked to build the exact dashboard, connect Robinhood holdings to its UI, restore missing sections or interactions, validate visual parity, or scaffold the same local dashboard in another project.
---

# Build the Robinhood portfolio dashboard

Treat `assets/index.html` as immutable visual truth. Reuse its DOM, CSS, responsive rules, and interactions directly. Do not redesign, simplify, substitute a component library, remove sections, or restyle unavailable data.

## Required workflow

1. Read `references/ui-contract.md` and `references/data-contract.md` completely.
2. Inspect the target before writing. Preserve unrelated files and existing secrets.
3. For a new target, run `python3 scripts/scaffold.py TARGET`. The command refuses to overwrite files unless the user explicitly authorizes `--force`.
4. Keep the same-origin Flask routes and normalize broker results to the documented `DATA` contract.
5. Use Robinhood first. Query Yahoo Finance only for a missing required public market field and label the fallback.
6. Render unavailable values as `—` or `Unavailable`; never synthesize authoritative tax results.
7. Run `python3 scripts/validate.py TARGET` before reporting completion.

## Non-negotiable rules

- Keep all canonical sections and their order.
- Keep desktop, tablet, and phone behavior plus keyboard/touch operation.
- Keep the heatmap, filters, sorting, themes, tooltip behavior, drawer focus trap, focus restoration, and Escape close.
- Keep credentials server-side and in memory. Bind to `127.0.0.1`; default to non-persistent sessions.
- Never add order-placement, cancellation, transfer, options, or crypto functionality.
- Never commit credentials, tokens, account numbers, session pickles, cached payloads, or real portfolio fixtures.
- Keep the browser and API on the same origin; do not enable permissive CORS.
- Preserve source/freshness labels on every holding and the portfolio snapshot.

## Maintenance

When intentionally updating the canonical top-level app in this repository, run `python3 scripts/update_assets.py` from this skill directory and then run both validators. Canonical assets and the working app must remain byte-identical.
