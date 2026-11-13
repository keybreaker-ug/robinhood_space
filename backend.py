"""Local Ravenhood API. Run with `python backend.py`."""
from datetime import timedelta
from functools import wraps
import hmac
import os
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, send_from_directory, session

from auth import BrowserSession, application_secret
from atlas_adapter import snapshot as atlas_snapshot
from broker_data import collect_portfolio, complete_portfolio, holding_detail, load_portfolio
from research import atlas_benchmarks, atlas_security, atlas_sp500_history, benchmark_history_snapshot, research_snapshots

ROOT = Path(__file__).resolve().parent


def create_app(config=None):
    app = Flask(__name__, static_folder=str(ROOT / "static"), instance_path=str(ROOT / "instance"))
    app.config.update(
        SESSION_COOKIE_NAME="ravenhood_session", SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict", SESSION_REFRESH_EACH_REQUEST=False,
        PERMANENT_SESSION_LIFETIME=timedelta(minutes=45),
        TRUSTED_HOSTS=["localhost", "127.0.0.1", "[::1]"],
        MAX_CONTENT_LENGTH=16384,
        SESSION_STATE_PATH=ROOT / "instance" / "browser-session.json",
        BROKER_TOKEN_DIRECTORY=Path.home() / ".tokens" / "ravenhood",
    )
    app.config.update(config or {})
    if not app.config.get("SECRET_KEY"):
        app.secret_key = os.environ.get("RAVENHOOD_SECRET_KEY") or application_secret(ROOT / "instance" / "secret.key")
    controller = BrowserSession(app.config["SESSION_STATE_PATH"], app.config["BROKER_TOKEN_DIRECTORY"])
    app.extensions["browser_session"] = controller
    snapshot_cache = None
    snapshot_lock = Lock()
    snapshot_ttl = 30

    @app.before_request
    def check_origin():
        if not request.path.startswith("/api/"):
            return None
        origin = request.headers.get("Origin")
        expected = urlsplit(request.host_url)
        if origin:
            try:
                actual = urlsplit(origin)
            except ValueError:
                return jsonify(success=False, message="Invalid request origin."), 403
            if (actual.scheme, actual.netloc) != (expected.scheme, expected.netloc):
                return jsonify(success=False, message="Cross-origin API requests are not allowed."), 403
        if request.headers.get("Sec-Fetch-Site") in ("same-site", "cross-site"):
            return jsonify(success=False, message="Cross-origin API requests are not allowed."), 403

    @app.after_request
    def response_headers(response):
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
            "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-DNS-Prefetch-Control"] = "off"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith("/api/") or request.path == "/":
            response.headers["Cache-Control"] = "no-store"
        return response

    def authenticated(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            # robin-stocks owns one process-wide HTTP connection. Serialize its
            # use so login/logout cannot switch accounts during a data request.
            with controller.lock:
                if not controller.authorize():
                    session.clear()
                    return jsonify(success=False, message="Session expired or not signed in. Please sign in again."), 401
                return function(*args, **kwargs)
        return wrapped

    @app.get("/")
    def index():
        return send_from_directory(ROOT / "static" / "portfolio-atlas", "index.html")

    @app.get("/api/atlas/snapshot")
    def atlas_portfolio():
        nonlocal snapshot_cache
        try:
            with snapshot_lock:
                with controller.lock:
                    state = controller.authorize()
                    if not state:
                        return jsonify(error="Sign in to Robinhood to continue."), 401
                    key = state["id_hash"]
                    if request.args.get("refresh") != "1" and snapshot_cache and snapshot_cache[0] == key and monotonic() - snapshot_cache[1] < snapshot_ttl:
                        return jsonify(snapshot_cache[2])
                    inputs = collect_portfolio()
                # All remaining work uses captured data and public market prices.
                result = atlas_snapshot(complete_portfolio(*inputs, include_monthly=False))
                with controller.lock:
                    state = controller.authorize()
                    if not state or state["id_hash"] != key:
                        return jsonify(error="Sign in to Robinhood to continue."), 401
                    snapshot_cache = (key, monotonic(), result)
                return jsonify(result)
        except Exception:
            app.logger.exception("Atlas snapshot failed")
            return jsonify(error="The Robinhood portfolio could not be loaded."), 502

    @app.get("/api/atlas/benchmarks")
    def atlas_market():
        with controller.lock:
            if not controller.authorize():
                return jsonify(error="Sign in to Robinhood to continue."), 401
        return jsonify(atlas_benchmarks())

    @app.get("/api/atlas/benchmarks/sp500")
    def atlas_sp500():
        with controller.lock:
            if not controller.authorize():
                return jsonify(error="Sign in to Robinhood to continue."), 401
        try:
            return jsonify(points=atlas_sp500_history())
        except Exception:
            return jsonify(error="S&P 500 history is temporarily unavailable."), 502

    @app.get("/api/atlas/security/<kind>/<symbol>/<view>")
    def atlas_holding(kind, symbol, view):
        with controller.lock:
            if not controller.authorize():
                return jsonify(error="Sign in to Robinhood to continue."), 401
        if (kind not in ("stock", "etf", "crypto") or view not in ("chart", "financials", "news")
                or not re.fullmatch(r"[A-Z0-9.^=-]{1,20}", symbol)):
            return jsonify(error="Unknown security or view."), 400
        return jsonify(atlas_security(symbol, kind, view))

    @app.get("/api/check-session")
    def check_session():
        with controller.lock:
            state = controller.authorize()
            if not state:
                session.clear()
            return jsonify(success=True, logged_in=bool(state), session_info=controller.info(state) if state else None)

    @app.get("/api/session-info")
    @authenticated
    def session_info():
        return jsonify(success=True, session_info=controller.info(controller.read_state()))

    @app.post("/api/login")
    def login():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(success=False, message="Send a JSON object containing your credentials."), 400
        username, password = data.get("username"), data.get("password")
        mfa = data.get("mfa_code") or data.get("mfaCode") or ""
        if not isinstance(username, str) or not isinstance(password, str) or not isinstance(mfa, str) or not username.strip() or not password:
            return jsonify(success=False, message="Username and password are required."), 400
        with controller.lock:
            try:
                result, state = controller.login(username.strip(), password, mfa.strip())
                if state:
                    return jsonify(success=True, requires_2fa=False, session_info=controller.info(state))
                requires_mfa = isinstance(result, dict) and bool(result.get("mfa_required") or result.get("challenge"))
                return jsonify(success=False, requires_2fa=requires_mfa,
                               message="Robinhood requires additional verification. Check the Robinhood app and try again." if requires_mfa else
                               "Sign-in failed. Check your credentials and Robinhood approval prompts."), 401
            except Exception as error:
                app.logger.warning("Broker sign-in failed (%s)", type(error).__name__)
                return jsonify(success=False, message="Robinhood sign-in could not be completed. Check approval prompts and try again."), 502

    @app.get("/api/portfolio")
    @authenticated
    def portfolio():
        try:
            data = load_portfolio()
            state = controller.read_state()
            data["researchScope"] = hmac.digest(str(app.secret_key).encode(), state["scope"].encode(), "sha256").hex()
            return jsonify(success=True, data=data)
        except Exception:
            app.logger.exception("Portfolio refresh failed")
            return jsonify(success=False, message="Portfolio data could not be retrieved. Refresh or sign in again."), 502

    @app.get("/api/holding/<symbol>")
    @authenticated
    def holding(symbol):
        symbol = symbol.upper()
        kind = request.args.get("assetType", "stock")
        if not re.fullmatch(r"[A-Z0-9.^=-]{1,20}", symbol) or kind not in ("stock", "etf", "crypto"):
            return jsonify(success=False, message="Invalid holding symbol or asset type."), 400
        try:
            return jsonify(success=True, data=holding_detail(symbol, kind))
        except Exception:
            app.logger.exception("Holding detail failed")
            return jsonify(success=False, message="Market history is temporarily unavailable."), 502

    @app.post("/api/research")
    def research():
        with controller.lock:
            if not controller.authorize():
                session.clear()
                return jsonify(success=False, message="Session expired or not signed in. Please sign in again."), 401
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(success=False, message="Invalid research request."), 400
        mode, symbols = payload.get("mode"), payload.get("symbols")
        if mode not in ("market", "funds", "quotes") or not isinstance(symbols, list) or not 1 <= len(symbols) <= 12:
            return jsonify(success=False, message="Select up to 12 tickers per request."), 400
        items = []
        for row in symbols:
            if not isinstance(row, dict):
                return jsonify(success=False, message="Invalid ticker."), 400
            symbol, kind = row.get("symbol"), row.get("assetType")
            if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9.^=-]{1,20}", symbol.upper()) or kind not in ("stock", "etf", "crypto"):
                return jsonify(success=False, message="Invalid ticker or asset type."), 400
            if mode == "funds" and kind != "etf":
                return jsonify(success=False, message="Fund holdings require an ETF ticker."), 400
            items.append((symbol.upper(), kind))
        return jsonify(success=True, data=research_snapshots(list(dict.fromkeys(items)), mode))

    @app.get("/api/benchmarks/<symbol>")
    def benchmark(symbol):
        with controller.lock:
            if not controller.authorize():
                session.clear()
                return jsonify(success=False, message="Session expired or not signed in. Please sign in again."), 401
        if symbol not in ("VOO", "QQQ", "DIA", "BTC-USD"):
            return jsonify(success=False, message="Unknown benchmark."), 400
        try:
            return jsonify(success=True, data=benchmark_history_snapshot(symbol))
        except Exception:
            return jsonify(success=False, message="Benchmark prices are temporarily unavailable."), 502

    @app.post("/api/logout")
    @authenticated
    def logout():
        controller.invalidate()
        return jsonify(success=True)

    @app.post("/api/clear-session")
    @authenticated
    def clear_session():
        controller.invalidate(clear_saved=True)
        return jsonify(success=True)

    return app


app = create_app()

if __name__ == "__main__":
    print("Ravenhood dashboard: http://localhost:5005")
    app.run(debug=False, port=5005, host="127.0.0.1")
