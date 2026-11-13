# Ravenhood

Ravenhood is a local, read-only dashboard for Robinhood stocks, ETFs, and crypto.
It shows portfolio value, cost basis, XIRR, cash interest, and dividends. You can
explore transaction history, holdings, heatmaps, ETF sector exposure, and risk.
The Overview compares your portfolio with VOO using the same dated cash flows
and also shows a VOO simulation with purchases every two weeks. Holding pages
include adjusted price history, CAGR, and an S&P 500 comparison. Stock pages also
show analyst ratings, price targets, and news when available.

## Install and run

Install Git and Python 3.11. On Windows, run these commands in PowerShell:

```powershell
git clone --branch ug_work https://github.com/keybreaker-ug/robinhood_space.git
cd robinhood_space
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe backend.py
```

On macOS or Linux, use `python3.11 -m venv .venv` and `.venv/bin/python` in place
of the Windows Python commands. The browser assets ship with the project, so
running the dashboard requires no Node.js install or frontend build.

Open [http://localhost:5005](http://localhost:5005), sign in with Robinhood, and
approve the sign-in in the Robinhood app if prompted. Use the same hostname on
subsequent visits so the browser can send the matching session cookie. The
first load waits for the portfolio snapshot, benchmarks, and ETF sector data.

## Robin Stocks setup

The pinned [`robin-stocks==3.4.0`](https://pypi.org/project/robin-stocks/3.4.0/)
release works as installed by `requirements.txt`. No fork or edits to
`site-packages` are required. Ravenhood keeps its Robinhood-specific handling in
[`auth.py`](auth.py) and [`broker_data.py`](broker_data.py). These modules handle
session ownership and restoration, broker history pagination, and normalization
of stock, ETF, crypto, and dividend records.

The server binds to `127.0.0.1` for local use. It contacts Robinhood for sign-in and
account data and Yahoo Finance for public market data. Browser sessions expire
45 minutes after sign-in. Session files and the signing key live in `instance/`,
and broker token caches live under `~/.tokens/ravenhood/`. Keep these files private.

## Checks and source

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests
node --test tests/atlas.test.cjs tests/frontend.test.cjs tests/research.test.cjs
```

The JavaScript tests require Node.js 24. The tests use fixtures and do not require
Robinhood credentials. The active frontend in `static/portfolio-atlas/` adapts
[Portfolio Atlas](https://github.com/Srihari1729/portfolio-atlas-framework/tree/379abc2006b9c9ae24061fa8435fc84ada5d99d6).
See [LICENSE](LICENSE) for the Ravenhood license.
