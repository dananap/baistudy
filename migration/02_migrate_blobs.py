"""Phase 1b: copy word_audio.data and word_images.data into Supabase Storage.

Idempotent: rows that already have `storage_path` are skipped. The `data`
column is set to NULL after a successful upload (to reclaim DB space — run
VACUUM FULL after).

Usage:
    SUPABASE_URL=...                      \\
    SUPABASE_SERVICE_ROLE_KEY=...         \\
    DATABASE_URL='postgresql+psycopg2://...supabase pooler...'  \\
    python migration/02_migrate_blobs.py

Run from the project root (so it can `import` from flashcard-backend).
"""
from __future__ import annotations

import logging
import os
import sys
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("blob-migrate")

# Allow `import models` etc.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "flashcard-backend"))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from supabase import create_client

AUDIO_BUCKET = os.environ.get("SUPABASE_AUDIO_BUCKET", "word-audio")
IMAGE_BUCKET = os.environ.get("SUPABASE_IMAGE_BUCKET", "word-images")


def _ext(mimetype: str) -> str:
    return {
        "audio/wav":  ".wav",
        "audio/mpeg": ".mp3",
        "image/jpeg": ".jpg",
        "image/png":  ".png",
        "image/gif":  ".gif",
        "image/webp": ".webp",
        "image/avif": ".avif",
    }.get(mimetype, "")


def _ensure_bucket(sb, name: str) -> None:
    existing = {b.name for b in sb.storage.list_buckets()}
    if name not in existing:
        log.info("Creating bucket %s", name)
        sb.storage.create_bucket(name, options={"public": False})


def main() -> int:
    db_url = os.environ["DATABASE_URL"]
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    _ensure_bucket(sb, AUDIO_BUCKET)
    _ensure_bucket(sb, IMAGE_BUCKET)

    # Run idempotent schema migrations so newly-added columns (e.g.
    # word_audio.storage_path) exist before we query the ORM.
    from database import init_db  # noqa: E402
    init_db()

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)

    from models import WordAudio, WordImage  # noqa: E402

    with Session() as db:
        # ── Audio ──
        rows = db.query(WordAudio).filter(
            WordAudio.storage_path.is_(None),
            WordAudio.data.isnot(None),
        ).all()
        log.info("Audio rows to migrate: %d", len(rows))
        for row in rows:
            path = f"audio-{row.id}/{uuid.uuid4().hex}{_ext(row.mimetype)}"
            sb.storage.from_(AUDIO_BUCKET).upload(
                path=path, file=bytes(row.data),
                file_options={"content-type": row.mimetype, "upsert": "false"},
            )
            row.storage_path = path
            row.data = None
            db.commit()
            log.info("audio id=%d → %s", row.id, path)

        # ── Images ──
        rows = db.query(WordImage).filter(
            WordImage.storage_path.is_(None),
            WordImage.data.isnot(None),
        ).all()
        log.info("Image rows to migrate: %d", len(rows))
        for row in rows:
            path = f"image-{row.id}/{uuid.uuid4().hex}{_ext(row.mimetype)}"
            sb.storage.from_(IMAGE_BUCKET).upload(
                path=path, file=bytes(row.data),
                file_options={"content-type": row.mimetype, "upsert": "false"},
            )
            row.storage_path = path
            row.data = None
            db.commit()
            log.info("image id=%d → %s", row.id, path)

    log.info("Done. Consider: psql -c 'VACUUM FULL word_audio, word_images;'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
