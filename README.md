# Robinhood Portfolio Dashboard

A private, local-first U.S. stocks and ETFs dashboard. The Flask backend signs in to Robinhood, normalizes broker data into the dashboard contract, and serves a self-contained responsive interface with portfolio analytics, benchmarks, heatmaps, XIRR, holdings, activity, estimated open lots, and data-quality disclosures.

The application binds only to `127.0.0.1`. Credentials, sessions, API payloads, and real portfolio data are neither included nor intended to be committed.

## Dashboard

The interface includes:

- Overview, SPY/QQQ benchmarks, portfolio heatmap, and money-weighted returns
- Allocation, valuation, sectors, market-cap buckets, and ETF analysis
- Searchable/filterable/sortable holdings with a keyboard-accessible details drawer
- Concentration risk, winners/losers, and 52-week positioning
- Robinhood orders, dividends, splits, events, estimated open lots, and data quality
- Responsive desktop/tablet/phone layouts, light/dark themes, tooltips, and sticky navigation

Robinhood is the primary source for holdings, quotes, fundamentals, instruments, orders, dividends, splits, events, and market state. Yahoo Finance is called only when a required public market field is absent, and every affected holding is tagged in the UI. Unsupported realized gains and authoritative tax lots remain visibly `Unavailable`; estimated FIFO lots are analytical context, not tax records.

## Run locally

Requires Python 3.10+ and a Robinhood account.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend.py
```

Open [http://127.0.0.1:5005](http://127.0.0.1:5005), then enter the account email, password, and an MFA code if Robinhood requests one.

Session persistence is disabled by default. To opt in to `robin-stocks` session storage on a trusted private machine, set `ROBINHOOD_STORE_SESSION=true` before starting the server. Never expose this development server to a network or commit its local token files.

## API

- `POST /api/login` — accepts `username`, `password`, and optional `mfa_code` or `mfaCode`
- `GET /api/portfolio` — returns the normalized dashboard payload; `?refresh=1` bypasses the short in-memory cache
- `POST /api/logout` — ends the Robinhood session and clears in-memory portfolio data

## Reusable Claude skill

The project-scoped skill is at `.claude/skills/building-robinhood-dashboard/`. In Claude Code, invoke `/building-robinhood-dashboard` and provide a target folder. The skill contains:

- the canonical sanitized frontend and backend
- a synthetic U.S. portfolio fixture
- immutable UI and data contracts
- a safe scaffold script
- an exactness, security, and private-data validator

Example:

```bash
python .claude/skills/building-robinhood-dashboard/scripts/scaffold.py /tmp/robinhood-dashboard
python .claude/skills/building-robinhood-dashboard/scripts/validate.py /tmp/robinhood-dashboard
```

The scaffold refuses to overwrite a non-empty target unless `--force` is explicitly supplied.

## Validate

```bash
pip install -r requirements-dev.txt
pytest -q
python .claude/skills/building-robinhood-dashboard/scripts/validate.py .
```

The test suite covers authentication states, MFA, empty and fractional portfolios, ETF classification, Robinhood/Yahoo source mapping, unavailable fields, frontend structure, JavaScript parsing, sanitization, responsive contracts, and clean-room skill reproduction.

## Security and limitations

Robinhood does not publish a supported public retail brokerage API for this workflow; `robin-stocks` can break when private endpoints change. Use a trusted local machine, read-only portfolio access, and your own account. This software does not place orders and is not investment or tax advice.

## License

Apache-2.0. See `LICENSE`.
