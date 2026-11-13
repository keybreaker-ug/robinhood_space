"""A single local broker connection owned by an authenticated browser session."""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import pickle
import re
import secrets
import threading
import time

from flask import session
import robin_stocks.robinhood as rh


def private_write(path, contents):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(contents)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def application_secret(path):
    path = Path(path)
    if not path.exists():
        private_write(path, secrets.token_hex(32))
    secret = path.read_text(encoding="utf-8").strip()
    if len(secret) < 32:
        raise ValueError("The local session signing key is invalid.")
    return secret


class BrowserSession:
    def __init__(self, state_path, token_directory, timeout_minutes=45):
        self.state_path = Path(state_path)
        self.token_directory = Path(token_directory)
        self.timeout = timeout_minutes * 60
        self.lock = threading.RLock()
        self.broker_ready = False

    def read_state(self):
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
            if (not re.fullmatch(r"[a-f0-9]{64}", state["scope"]) or
                    not re.fullmatch(r"[a-f0-9]{64}", state["id_hash"]) or
                    not re.fullmatch(r"[a-f0-9]{64}", state["fingerprint"])):
                return None
            if not isinstance(state["started_at"], (int, float)) or not math.isfinite(state["started_at"]):
                return None
            return state
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def token_path(self, state):
        return self.token_directory / state["scope"] / "robinhood.pickle"

    def remaining(self, state):
        elapsed = time.time() - state["started_at"]
        return max(0, int(self.timeout - elapsed)) if elapsed >= 0 else 0

    def restore(self, state):
        """Restore only for the owner cookie, without prompting or renewing expiry."""
        path = self.token_path(state)
        try:
            payload = path.read_bytes()
            if not secrets.compare_digest(hashlib.sha256(payload).hexdigest(), state["fingerprint"]):
                return False
            # This is the private, locally created robin-stocks session cache.
            token = pickle.loads(payload)
            if not isinstance(token, dict) or not all(isinstance(token.get(k), str) and token[k]
                                                      for k in ("access_token", "token_type")):
                return False
            rh.helper.update_session("Authorization", f"{token['token_type']} {token['access_token']}")
            rh.helper.set_login_state(True)
            profile = rh.profiles.load_account_profile()
            if not isinstance(profile, dict) or not profile:
                raise ValueError("Saved broker session is invalid")
            self.broker_ready = True
            return True
        except Exception:
            self.clear_broker()
            return False

    def authorize(self):
        state = self.read_state()
        browser_id = session.get("auth_id")
        if not state or not isinstance(browser_id, str):
            return None
        digest = hashlib.sha256(browser_id.encode()).hexdigest()
        if not secrets.compare_digest(digest, state["id_hash"]):
            return None
        if not self.remaining(state):
            self.invalidate()
            return None
        if not self.broker_ready and not self.restore(state):
            self.invalidate()
            return None
        return state

    def establish(self, username):
        scope = hashlib.sha256(username.strip().lower().encode()).hexdigest()
        path = self.token_directory / scope / "robinhood.pickle"
        state = {"scope": scope, "started_at": time.time(),
                 "fingerprint": hashlib.sha256(path.read_bytes()).hexdigest()}
        browser_id = secrets.token_urlsafe(32)
        state["id_hash"] = hashlib.sha256(browser_id.encode()).hexdigest()
        private_write(self.state_path, json.dumps(state))
        session.clear()
        session.permanent = True
        session["auth_id"] = browser_id
        self.broker_ready = True
        return state

    def login(self, username, password, mfa_code=None):
        scope = hashlib.sha256(username.strip().lower().encode()).hexdigest()
        directory = self.token_directory / scope
        directory.mkdir(parents=True, exist_ok=True)
        # robin-stocks skips password validation when it finds a cached token.
        # Explicit login must authenticate fresh; only the owner cookie may use
        # restore(). Keep the old cache intact if the new login fails.
        pending = directory / ("login-" + secrets.token_hex(16))
        pending.mkdir()
        try:
            result = rh.login(username=username, password=password, mfa_code=mfa_code or None,
                              store_session=True, pickle_path=str(pending))
            if isinstance(result, dict) and result.get("access_token"):
                os.replace(pending / "robinhood.pickle", directory / "robinhood.pickle")
                os.chmod(directory / "robinhood.pickle", 0o600)
                return result, self.establish(username)
            self.clear_broker()
            return result, None
        except Exception:
            self.clear_broker()
            raise
        finally:
            (pending / "robinhood.pickle").unlink(missing_ok=True)
            pending.rmdir()

    def clear_broker(self):
        rh.helper.set_login_state(False)
        rh.helper.update_session("Authorization", None)
        self.broker_ready = False

    def invalidate(self, clear_saved=False):
        state = self.read_state()
        if clear_saved and state:
            self.token_path(state).unlink(missing_ok=True)
        self.state_path.unlink(missing_ok=True)
        session.clear()
        self.clear_broker()

    def info(self, state):
        return {"remaining_seconds": self.remaining(state), "timeout_minutes": self.timeout // 60,
                "expires_at": datetime.fromtimestamp(state["started_at"] + self.timeout, timezone.utc).isoformat()}
