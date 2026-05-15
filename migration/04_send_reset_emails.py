"""Phase 2 (post-import): send a password-reset email to every migrated user.

Run AFTER 03_import_users.py. Reads emails from the Firebase export to know
who to mail. Idempotent — Supabase rate-limits per-email but otherwise
re-sending is harmless.

Usage:
    SUPABASE_URL=...                      \\
    SUPABASE_SERVICE_ROLE_KEY=...         \\
    REDIRECT_URL='https://baistudy.pages.dev/login'  \\
    python migration/04_send_reset_emails.py --firebase-export firebase-users.json
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reset-emails")

from supabase import create_client


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--firebase-export", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--sleep", type=float, default=1.0, help="Seconds between sends (rate-limit safety)")
    args = p.parse_args()

    with open(args.firebase_export) as f:
        fb = json.load(f)
    emails = sorted({u["email"] for u in fb.get("users", []) if u.get("email")})

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    redirect_to = os.environ.get("REDIRECT_URL") or "https://baistudy.pages.dev/login"

    log.info("Sending reset to %d emails (redirect: %s)", len(emails), redirect_to)
    for email in emails:
        if args.dry_run:
            log.info("would send reset to %s", email)
            continue
        try:
            sb.auth.reset_password_for_email(email, {"redirect_to": redirect_to})
            log.info("sent: %s", email)
        except Exception as e:
            log.warning("failed for %s: %s", email, e)
        time.sleep(args.sleep)

    return 0


if __name__ == "__main__":
    sys.exit(main())
