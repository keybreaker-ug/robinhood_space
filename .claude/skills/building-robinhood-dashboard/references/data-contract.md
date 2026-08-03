# Portfolio data contract

## Contents

- API surface
- Source precedence
- Dashboard schema
- Calculations
- Failure and privacy rules

## API surface

- `POST /api/login`: accept `username`, `password`, and optional `mfa_code`; return `success`, `message`, and `requires_2fa`.
- `GET /api/portfolio`: return `{success, data, cached}` after authentication.
- `GET /api/portfolio?refresh=1`: bypass the short in-memory cache.
- `POST /api/logout`: clear Robinhood and application login state.

Serve the HTML and API from the same Flask origin. Bind to `127.0.0.1` with debug disabled.

## Source precedence

Use Robinhood for holdings, quantity, average cost, quotes, previous close, fundamentals, filled stock executions, dividends, splits, events, and market state. Use Yahoo Finance only when a required quote or public metadata field is missing. Never replace an available Robinhood value with Yahoo data.

Set each holding `source` to `Robinhood` or `Robinhood + Yahoo fallback`, list the exact public fields in `fallback_fields`, and set `live=false` for fallback-priced holdings. Summarize live/fallback counts in `meta.live` and the holding note shown in the drawer.

## Dashboard schema

The `data` object must contain:

- `meta`: `holder`, `broker`, `generated`, and `live` with `asof`, `source`, `market`, `n_live`, `n_stale`.
- `totals`: value, stock/ETF splits and counts, day P&L, day percent, weighted PE, and top-10/top-20 weights.
- `holdings`: symbol/name, asset type (`Equity` or `ETF`), quantity, cost/current prices and values, gain, day move, PE, sector, industry, market cap/bucket, 52-week range, weight, term, source, live state, XIRR inputs, and warning note.
- `indices`: SPY and QQQ current level, previous close, day change, and source.
- `sectors` and `mcaps`: grouped value, count, weight, and available weighted PE.
- `lots`: symbol-keyed estimated open lots with date, term, quantity, reconciled rate, age, unrealized gain, and corporate-action label.
- `trades`: account-wide filled stock executions with symbol, display name, date, side, quantity, price, and notional.
- `cg`: unavailable realized fields, positive open-gain LT/ST split, dividend total, and largest estimated gain lots.

Use `null` for unavailable numeric values. Use finite native floats only; never emit NaN or Infinity.

## Calculations

- Current value = quantity × current price.
- Cost value = quantity × Robinhood average buy price.
- Day P&L = quantity × (current price − previous close).
- Portfolio PE is current-value weighted over positive, available stock PE values.
- Reconstruct open lots FIFO from filled executions, then reconcile lot quantity and aggregate cost to Robinhood’s current quantity and average cost.
- Mark lots held at least 365 days as LT; otherwise ST.
- Calculate current-holding XIRR from estimated open-lot outflows plus current terminal value.
- Treat lot and XIRR results as analytics, not broker tax records.

## Failure and privacy rules

- Empty accounts return the complete schema with empty collections and zero totals.
- Missing public metadata remains null/unclassified after fallback failure.
- Do not return raw Robinhood responses, user profiles, account numbers, access tokens, or authentication details.
- Do not log request bodies or exception strings that could contain sensitive data.
- Never persist real portfolio JSON as an application or test fixture.
