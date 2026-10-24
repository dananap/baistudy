"""Local stand-in for every third party the backend and frontend talk to.

One process, one port, three surfaces:

  /auth/v1/*        Supabase Auth (GoTrue) — password sign-in, sign-up,
                    refresh, user, logout, and the JWKS the backend verifies
                    against. Tokens are real ES256 JWTs signed with a key
                    generated at startup, so `supabase_jwt.py` runs unmodified.
  /storage/v1/*     Supabase Storage — upload/download/sign/public/remove,
                    held in memory.
  /deepseek/*       OpenAI-compatible chat completions (DeepSeek's API shape),
                    streaming and not. Answers come from a script the tests
                    push via /__test/llm, else a generic default.

Plus /__test/* control endpoints the Playwright fixtures use to create users,
script LLM replies and reset state. Nothing here is secure; it binds to
loopback and exists only for the e2e suite.
"""
from __future__ import annotations

import argparse
import json
import socket
import threading
import time
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

KID = "e2e-stub-key"
ACCESS_TTL = 3600

_private_key = ec.generate_private_key(ec.SECP256R1())
_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(_private_key.public_key()))
_jwk.update({"kid": KID, "alg": "ES256", "use": "sig"})

_lock = threading.Lock()
_users: dict[str, dict] = {}            # email -> user record (incl. password)
_refresh: dict[str, str] = {}           # refresh token -> email
_objects: dict[tuple[str, str], tuple[bytes, str]] = {}   # (bucket, path) -> (data, mimetype)
_llm_script: list[dict] = []            # [{match, content}] consumed FIFO by first match
_llm_log: list[dict] = []               # every request's messages, for assertions

DEFAULT_LLM_REPLY = "好的。这是一个测试回答。"


# ── auth helpers ────────────────────────────────────────────────────────────

def _now() -> int:
    return int(time.time())


def _public_user(u: dict) -> dict:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(u["created"]))
    return {
        "id": u["id"], "aud": "authenticated", "role": "authenticated",
        "email": u["email"], "email_confirmed_at": ts, "confirmed_at": ts,
        "last_sign_in_at": ts, "created_at": ts, "updated_at": ts,
        "app_metadata": {"provider": "email", "providers": ["email"]},
        "user_metadata": {}, "identities": [], "is_anonymous": False,
    }


def _session_for(u: dict) -> dict:
    iat = _now()
    claims = {
        "sub": u["id"], "email": u["email"], "role": "authenticated",
        "aud": "authenticated", "iat": iat, "exp": iat + ACCESS_TTL,
        "session_id": str(uuid.uuid4()), "is_anonymous": False,
    }
    access = jwt.encode(claims, _private_key, algorithm="ES256", headers={"kid": KID})
    refresh = uuid.uuid4().hex
    _refresh[refresh] = u["email"]
    return {
        "access_token": access, "token_type": "bearer", "expires_in": ACCESS_TTL,
        "expires_at": iat + ACCESS_TTL, "refresh_token": refresh, "user": _public_user(u),
    }


def _create_user(email: str, password: str) -> dict:
    email = email.strip().lower()
    u = {"id": str(uuid.uuid4()), "email": email, "password": password, "created": _now()}
    _users[email] = u
    return u


def _user_from_bearer(header: str | None) -> dict | None:
    if not header or not header.startswith("Bearer "):
        return None
    try:
        claims = jwt.decode(header[7:], _private_key.public_key(), algorithms=["ES256"],
                            audience="authenticated")
    except jwt.PyJWTError:
        return None
    return _users.get(claims.get("email", ""))


# ── LLM helpers ─────────────────────────────────────────────────────────────

def _llm_reply(body: dict) -> str:
    messages = body.get("messages") or []
    text = "\n".join(str(m.get("content", "")) for m in messages)
    with _lock:
        _llm_log.append({"model": body.get("model"), "messages": messages})
        for i, entry in enumerate(_llm_script):
            if not entry.get("match") or entry["match"] in text:
                if not entry.get("sticky"):
                    _llm_script.pop(i)
                return entry["content"]
    return DEFAULT_LLM_REPLY


def _completion(content: str, model: str) -> dict:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}", "object": "chat.completion",
        "created": _now(), "model": model,
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": len(content), "total_tokens": 10 + len(content)},
    }


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "e2e-stub"

    def log_message(self, fmt, *args):  # quiet; failures surface in tests
        pass

    # plumbing
    def _cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         self.headers.get("Access-Control-Request-Headers") or "*")
        self.send_header("Access-Control-Expose-Headers", "*")

    def _send(self, status: int, body: bytes = b"", ctype: str = "application/json"):
        self.send_response(status)
        self._cors()
        if body or status != 204:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj, ensure_ascii=False).encode())

    def _error(self, status: int, code: str, msg: str) -> None:
        self._json(status, {"code": status, "error_code": code, "msg": msg,
                            "error": code, "error_description": msg, "message": msg})

    def _raw_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _body(self) -> dict:
        raw = self._raw_body()
        return json.loads(raw) if raw else {}

    # verbs
    def do_OPTIONS(self):
        self._send(204)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method: str):
        url = urlparse(self.path)
        p = url.path
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if p == "/health":
                return self._json(200, {"ok": True})
            if p.startswith("/__test/"):
                return self._test_api(method, p)
            if p.startswith("/auth/v1/"):
                return self._auth(method, p[len("/auth/v1"):], q)
            if p.startswith("/storage/v1/"):
                return self._storage(method, p[len("/storage/v1"):])
            if p.startswith("/deepseek/"):
                return self._deepseek(method, p[len("/deepseek"):])
            self._error(404, "not_found", f"stub has no route for {method} {p}")
        except Exception as e:  # surface stub bugs as 500s, not hangs
            self._error(500, "stub_error", repr(e))

    # /__test
    def _test_api(self, method: str, p: str):
        if p == "/__test/users" and method == "POST":
            b = self._body()
            with _lock:
                email = b.get("email") or f"e2e-{uuid.uuid4().hex[:10]}@example.test"
                u = _create_user(email, b.get("password") or "e2e-password")
                return self._json(200, {"user": _public_user(u), "password": u["password"],
                                        "session": _session_for(u)})
        if p == "/__test/llm" and method == "POST":
            b = self._body()
            with _lock:
                _llm_script.append({"match": b.get("match"), "content": b["content"],
                                    "sticky": bool(b.get("sticky"))})
            return self._json(200, {"queued": len(_llm_script)})
        if p == "/__test/llm" and method == "GET":
            with _lock:
                return self._json(200, {"requests": _llm_log, "pending": _llm_script})
        if p == "/__test/reset" and method == "POST":
            with _lock:
                _llm_script.clear()
                _llm_log.clear()
            return self._json(200, {"ok": True})
        self._error(404, "not_found", p)

    # /auth/v1
    def _auth(self, method: str, p: str, q: dict):
        if p == "/.well-known/jwks.json":
            return self._json(200, {"keys": [_jwk]})
        if p == "/settings":
            return self._json(200, {"external": {"email": True}, "disable_signup": False,
                                    "mailer_autoconfirm": True})
        if p == "/token" and method == "POST":
            b = self._body()
            grant = q.get("grant_type")
            with _lock:
                if grant == "password":
                    u = _users.get((b.get("email") or "").strip().lower())
                    if not u or u["password"] != b.get("password"):
                        return self._error(400, "invalid_credentials", "Invalid login credentials")
                    return self._json(200, _session_for(u))
                if grant == "refresh_token":
                    email = _refresh.pop(b.get("refresh_token") or "", None)
                    if not email:
                        return self._error(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found")
                    return self._json(200, _session_for(_users[email]))
            return self._error(400, "unsupported_grant_type", f"grant_type={grant}")
        if p == "/signup" and method == "POST":
            b = self._body()
            with _lock:
                email = (b.get("email") or "").strip().lower()
                if email in _users:
                    return self._error(422, "user_already_exists", "User already registered")
                return self._json(200, _session_for(_create_user(email, b.get("password") or "")))
        if p == "/user":
            u = _user_from_bearer(self.headers.get("Authorization"))
            if not u:
                return self._error(401, "bad_jwt", "invalid JWT")
            if method == "PUT":
                b = self._body()
                if b.get("password"):
                    u["password"] = b["password"]
            return self._json(200, _public_user(u))
        if p == "/logout" and method == "POST":
            return self._send(204)
        if p == "/recover" and method == "POST":
            return self._json(200, {})
        self._error(404, "not_found", f"auth stub: {method} {p}")

    # /storage/v1
    def _storage(self, method: str, p: str):
        parts = [s for s in p.split("/") if s]
        if not parts or parts[0] != "object":
            return self._error(404, "not_found", p)
        rest = parts[1:]
        if rest and rest[0] in ("public", "authenticated") and method in ("GET", "HEAD"):
            return self._serve_object(rest[1], "/".join(rest[2:]))
        if rest and rest[0] == "sign":
            bucket, path = rest[1], "/".join(rest[2:])
            if method == "POST":
                self._raw_body()
                return self._json(200, {"signedURL": f"/object/sign/{bucket}/{path}?token=e2e"})
            return self._serve_object(bucket, path)
        if method == "DELETE" and len(rest) == 1:
            prefixes = self._body().get("prefixes") or []
            with _lock:
                for path in prefixes:
                    _objects.pop((rest[0], path), None)
            return self._json(200, [{"name": x} for x in prefixes])
        bucket, path = rest[0], "/".join(rest[1:])
        if method in ("POST", "PUT"):
            data, mimetype = self._read_upload()
            with _lock:
                _objects[(bucket, path)] = (data, mimetype)
            return self._json(200, {"Key": f"{bucket}/{path}", "Id": str(uuid.uuid4())})
        if method in ("GET", "HEAD"):
            return self._serve_object(bucket, path)
        self._error(405, "method_not_allowed", p)

    def _read_upload(self) -> tuple[bytes, str]:
        raw = self._raw_body()
        ctype = self.headers.get("Content-Type", "application/octet-stream")
        if not ctype.startswith("multipart/"):
            return raw, ctype
        msg = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {ctype}\r\n\r\n".encode() + raw)
        for part in msg.iter_parts():
            if part.get_param("name", header="content-disposition") == "file":
                return part.get_payload(decode=True), part.get_content_type()
        return raw, "application/octet-stream"

    def _serve_object(self, bucket: str, path: str):
        with _lock:
            obj = _objects.get((bucket, path))
        if obj is None:
            return self._error(404, "not_found", "Object not found")
        self._send(200, obj[0], obj[1])

    # /deepseek (OpenAI-compatible)
    def _deepseek(self, method: str, p: str):
        if p.rstrip("/") == "/models":
            return self._json(200, {"object": "list", "data": [{"id": "deepseek-flash", "object": "model"}]})
        if p.rstrip("/") != "/chat/completions" or method != "POST":
            return self._error(404, "not_found", p)
        body = self._body()
        model = body.get("model") or "deepseek-flash"
        content = _llm_reply(body)
        if not body.get("stream"):
            return self._json(200, _completion(content, model))

        # SSE stream: role chunk, a few content chunks, finish + usage, [DONE].
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def chunk(delta: dict, finish=None, usage=None):
            obj = {"id": cid, "object": "chat.completion.chunk", "created": _now(), "model": model,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage:
                obj["usage"] = usage
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        chunk({"role": "assistant", "content": ""})
        step = max(1, len(content) // 4)
        for i in range(0, len(content), step):
            chunk({"content": content[i:i + step]})
        chunk({}, finish="stop",
              usage={"prompt_tokens": 10, "completion_tokens": len(content), "total_tokens": 10 + len(content)})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class DualStackServer(ThreadingHTTPServer):
    """Listen on IPv6 and IPv4 so both `localhost` resolutions reach us."""
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def serve(port: int) -> ThreadingHTTPServer:
    server = DualStackServer(("::", port), Handler)
    threading.Thread(target=server.serve_forever, name="stub", daemon=True).start()
    return server


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=54340)
    args = ap.parse_args()
    serve(args.port)
    print(f"stub listening on :{args.port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
