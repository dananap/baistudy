"""Boot the backend half of the e2e stack and keep it up until killed.

  1. A private Postgres cluster under e2e/.data/pg (initdb on first run; TCP on
     loopback only, no unix socket, trust auth).
  2. A fresh database cloned from a template that already holds the schema and
     the HSK catalog. The template is rebuilt only when the backend's models,
     migrations or catalog JSON change, so most runs skip the 2.5k-word import.
  3. The stub server (Supabase Auth + Storage, DeepSeek) — see stub_server.py.
  4. uvicorn on the backend, with every secret overridden so nothing from
     flashcard-backend/.env or .env.local (real keys, real databases) leaks in.

Playwright starts this as a webServer; for a fast edit-test loop, run it by
hand in a terminal and Playwright reuses it:

    flashcard-backend/.venv/bin/python e2e/stack/run_stack.py
"""
from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BACKEND = ROOT / "flashcard-backend"
DATA = HERE.parent / ".data"
PGDATA = DATA / "pg"

PG_PORT = int(os.environ.get("E2E_PG_PORT", "54350"))
STUB_PORT = int(os.environ.get("E2E_STUB_PORT", "54340"))
API_PORT = int(os.environ.get("E2E_API_PORT", "8010"))
WEB_PORT = int(os.environ.get("E2E_WEB_PORT", "5180"))
DB = "baistudy_e2e"
TEMPLATE = "baistudy_e2e_tpl"

sys.path.insert(0, str(HERE))
import stub_server  # noqa: E402


def log(msg: str) -> None:
    print(f"[stack] {msg}", flush=True)


def backend_env() -> dict[str, str]:
    """The environment for every backend process. Explicit values beat both
    dotenv files (pydantic-settings and python-dotenv never override a set
    variable), so each secret the backend knows about is pinned here."""
    stub = f"http://127.0.0.1:{STUB_PORT}"
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("GOOGLE_", "GCP_", "AZURE_", "SUPABASE_", "DEEPSEEK_"))}
    env.update({
        "DATABASE_URL": f"postgresql://postgres@127.0.0.1:{PG_PORT}/{DB}",
        "FAKE_PROVIDERS": "true",
        "SUPABASE_URL": stub,
        "SUPABASE_SERVICE_ROLE_KEY": "e2e.service.role",
        "DEEPSEEK_API_KEY": "e2e-fake",
        "DEEPSEEK_BASE_URL": f"{stub}/deepseek",
        "UNSPLASH_ACCESS_KEY": "",
        "ELEVENLABS_API_KEY": "",
        "AZURE_SPEECH_KEY": "",
        "GOOGLE_APPLICATION_CREDENTIALS": "/nonexistent/e2e-no-gcp.json",
        "GCP_SERVICE_ACCOUNT_JSON": "",
        "ORIGIN_SECRET": "",
        "ALLOWED_SIGNUP_EMAILS": "",
        "ALLOWED_ORIGINS": f'["http://localhost:{WEB_PORT}","http://127.0.0.1:{WEB_PORT}"]',
        "LOG_LEVEL": os.environ.get("E2E_LOG_LEVEL", "WARNING"),
        "LOG_FILE": "",
        "PYTHONUNBUFFERED": "1",
    })
    return env


# ── Postgres ────────────────────────────────────────────────────────────────

def pg_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise SystemExit(f"{name} not found — install PostgreSQL server binaries")
    return path


def start_postgres() -> None:
    if not (PGDATA / "PG_VERSION").exists():
        log(f"initdb {PGDATA}")
        PGDATA.mkdir(parents=True, exist_ok=True)
        subprocess.run([pg_bin("initdb"), "-D", str(PGDATA), "-U", "postgres",
                        "--auth=trust", "--encoding=UTF8", "--no-locale"],
                       check=True, stdout=subprocess.DEVNULL)
    status = subprocess.run([pg_bin("pg_ctl"), "-D", str(PGDATA), "status"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if status.returncode == 0:
        log("postgres already running")
        return
    opts = (f"-p {PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' "
            "-c fsync=off -c synchronous_commit=off -c full_page_writes=off")
    subprocess.run([pg_bin("pg_ctl"), "-D", str(PGDATA), "-l", str(DATA / "pg.log"),
                    "-o", opts, "-w", "start"], check=True, stdout=subprocess.DEVNULL)
    log(f"postgres on :{PG_PORT}")


def stop_postgres() -> None:
    subprocess.run([pg_bin("pg_ctl"), "-D", str(PGDATA), "-m", "fast", "stop"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def admin_sql(*statements: str) -> None:
    import psycopg2
    conn = psycopg2.connect(host="127.0.0.1", port=PG_PORT, user="postgres", dbname="postgres")
    conn.autocommit = True
    with conn.cursor() as cur:
        for s in statements:
            cur.execute(s)
    conn.close()


def template_fingerprint() -> str:
    """Hash of everything that shapes the template's contents."""
    h = hashlib.sha256()
    for rel in ("models.py", "database.py", "prompts.py", "import_catalog.py",
                "catalog/hsk-2012-l1-l5.json"):
        h.update((BACKEND / rel).read_bytes())
    return h.hexdigest()[:16]


def ensure_template() -> None:
    import psycopg2
    stamp = DATA / "template.fingerprint"
    fp = template_fingerprint()
    conn = psycopg2.connect(host="127.0.0.1", port=PG_PORT, user="postgres", dbname="postgres")
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TEMPLATE,))
        exists = cur.fetchone() is not None
    conn.close()
    if exists and stamp.exists() and stamp.read_text() == fp:
        return

    log("building template database (schema + HSK catalog)…")
    t0 = time.time()
    admin_sql(f"DROP DATABASE IF EXISTS {TEMPLATE} WITH (FORCE)", f"CREATE DATABASE {TEMPLATE}")
    env = backend_env()
    env["DATABASE_URL"] = f"postgresql://postgres@127.0.0.1:{PG_PORT}/{TEMPLATE}"
    subprocess.run([sys.executable, "import_catalog.py"], cwd=BACKEND, env=env, check=True,
                   stdout=subprocess.DEVNULL)
    stamp.write_text(fp)
    log(f"template ready in {time.time() - t0:.1f}s")


def fresh_database() -> None:
    admin_sql(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)",
              f"CREATE DATABASE {DB} TEMPLATE {TEMPLATE}")
    log(f"database {DB} cloned from template")


# ── main ────────────────────────────────────────────────────────────────────

def wait_http(url: str, proc: subprocess.Popen, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"backend exited with {proc.returncode} before becoming healthy")
        try:
            with urlopen(url, timeout=2):
                return
        except OSError:
            time.sleep(0.25)
    raise SystemExit(f"timed out waiting for {url}")


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    start_postgres()
    ensure_template()
    fresh_database()

    stub_server.serve(STUB_PORT)
    log(f"stub on :{STUB_PORT}")

    api = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
         "--port", str(API_PORT), "--log-level", "warning"],
        cwd=BACKEND, env=backend_env(),
    )

    def shutdown(*_):
        api.terminate()
        try:
            api.wait(10)
        except subprocess.TimeoutExpired:
            api.kill()
        if not os.environ.get("E2E_KEEP_PG"):
            stop_postgres()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    wait_http(f"http://127.0.0.1:{API_PORT}/health", api)
    log(f"backend on :{API_PORT} — ready")
    code = api.wait()
    log(f"backend exited with {code}")
    shutdown()


if __name__ == "__main__":
    main()
