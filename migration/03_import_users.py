"""Phase 2: pre-create Supabase auth users for each existing app user.

We're forcing a password reset for everyone, so this script only needs to
seed `auth.users` (no password hash import). After this runs, send the
reset emails via 04_send_reset_emails.py.

Reads existing users from the Postgres `users` table. Pulls emails from
the Firebase export JSON (passed as --firebase-export).

Usage:
    SUPABASE_URL=...                      \\
    SUPABASE_SERVICE_ROLE_KEY=...         \\
    DATABASE_URL='postgresql+psycopg2://...'  \\
    python migration/03_import_users.py --firebase-export firebase-users.json

The Firebase export is produced by:
    firebase auth:export firebase-users.json --project=baistudy
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("user-import")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "flashcard-backend"))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from supabase import create_client


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--firebase-export", required=True, help="Path to firebase auth:export JSON")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    with open(args.firebase_export) as f:
        fb = json.load(f)
    fb_users = fb.get("users", [])
    fb_by_uid = {u["localId"]: u for u in fb_users}

    db_url = os.environ["DATABASE_URL"]
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    # Run idempotent schema migrations so newly-added columns (e.g.
    # users.supabase_uid) exist before we query the ORM.
    from database import init_db  # noqa: E402
    init_db()

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)
    from models import User  # noqa: E402

    with Session() as db:
        app_users = db.query(User).all()
        log.info("App users found: %d", len(app_users))

        for u in app_users:
            if u.supabase_uid:
                log.info("user_id=%d already has supabase_uid — skipping", u.id)
                continue
            if not u.firebase_uid or u.firebase_uid not in fb_by_uid:
                log.warning("user_id=%d has no firebase_uid or missing in export — skipping", u.id)
                continue
            email = fb_by_uid[u.firebase_uid].get("email")
            if not email:
                log.warning("user_id=%d has no email — skipping", u.id)
                continue

            if args.dry_run:
                log.info("would create Supabase user for %s (user_id=%d)", email, u.id)
                continue

            # email_confirm=True so the user can log in with the password they set
            # after the reset link; otherwise they'd be blocked by "email not confirmed".
            resp = sb.auth.admin.create_user({
                "email": email,
                "email_confirm": True,
                "user_metadata": {"migrated_from": "firebase", "firebase_uid": u.firebase_uid},
            })
            new_uid = resp.user.id
            u.supabase_uid = new_uid
            db.commit()
            log.info("user_id=%d email=%s → supabase_uid=%s", u.id, email, new_uid)

    return 0


if __name__ == "__main__":
    sys.exit(main())
