"""Phase 1c: copy pronunciation_attempts.audio_data into Supabase Storage.

Idempotent: rows that already have `storage_path` are skipped. The `audio_data`
column is set to NULL after a successful upload (to reclaim DB space — run
VACUUM FULL after).

Usage:
    SUPABASE_URL=...                      \\
    SUPABASE_SERVICE_ROLE_KEY=...         \\
    DATABASE_URL='postgresql+psycopg2://...supabase pooler...'  \\
    python migration/05_migrate_pronunciation_blobs.py

Run from the project root (so it can `import` from flashcard-backend).
"""
from __future__ import annotations

import logging
import os
import sys
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pronunciation-migrate")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "flashcard-backend"))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from supabase import create_client

PRONUNCIATION_BUCKET = os.environ.get("SUPABASE_PRONUNCIATION_BUCKET", "pronunciation-attempts")


def _ext(mimetype: str) -> str:
    return {
        "audio/wav":  ".wav",
        "audio/mpeg": ".mp3",
        "audio/webm": ".webm",
        "audio/ogg":  ".ogg",
    }.get(mimetype, "")


def _ensure_bucket(sb, name: str) -> None:
    existing = {b.name for b in sb.storage.list_buckets()}
    if name not in existing:
        log.info("Creating bucket %s", name)
        sb.storage.create_bucket(name, options={"public": False})


def main() -> int:
    db_url = os.environ["DATABASE_URL"]
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    _ensure_bucket(sb, PRONUNCIATION_BUCKET)

    # Run idempotent schema migrations so newly-added columns
    # (pronunciation_attempts.storage_path) exist before we query the ORM.
    from database import init_db  # noqa: E402
    init_db()

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)

    from models import PronunciationAttempt  # noqa: E402

    with Session() as db:
        rows = db.query(PronunciationAttempt).filter(
            PronunciationAttempt.storage_path.is_(None),
            PronunciationAttempt.audio_data.isnot(None),
        ).all()
        log.info("Pronunciation rows to migrate: %d", len(rows))
        for row in rows:
            path = (
                f"user-{row.user_id}/word-{row.word_id}/"
                f"{uuid.uuid4().hex}{_ext(row.audio_mimetype)}"
            )
            sb.storage.from_(PRONUNCIATION_BUCKET).upload(
                path=path, file=bytes(row.audio_data),
                file_options={"content-type": row.audio_mimetype, "upsert": "false"},
            )
            row.storage_path = path
            row.audio_data = None
            db.commit()
            log.info("attempt id=%d → %s", row.id, path)

    log.info("Done. Consider: psql -c 'VACUUM FULL pronunciation_attempts;'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
