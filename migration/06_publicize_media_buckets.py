"""One-shot: flip the word-audio and word-images buckets to public.

Flashcard audio/images are served as stable public CDN URLs
(`supabase_storage.public_url`) so the browser fetches them straight from
Supabase's edge, skipping the backend media hop and the per-object signing
round-trip. That requires the buckets to be public. This script flips the two
existing (originally private) buckets; it is idempotent and safe to re-run.

It does NOT touch `pronunciation-attempts` or `hskk-*` — those hold user voice
recordings and stay private (served via signed URLs).

Usage (from the project root):
    SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  \
    python migration/06_publicize_media_buckets.py
"""
from __future__ import annotations

import logging
import os
import sys

from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("publicize-buckets")

PUBLIC_BUCKETS = [
    os.environ.get("SUPABASE_AUDIO_BUCKET", "word-audio"),
    os.environ.get("SUPABASE_IMAGE_BUCKET", "word-images"),
]


def main() -> int:
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    existing = {b.name: b for b in sb.storage.list_buckets()}

    for name in PUBLIC_BUCKETS:
        bucket = existing.get(name)
        if bucket is None:
            log.warning("Bucket %s does not exist — skipping", name)
            continue
        if getattr(bucket, "public", False):
            log.info("Bucket %s already public — nothing to do", name)
            continue
        log.info("Flipping bucket %s to public", name)
        sb.storage.update_bucket(name, options={"public": True})

    log.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
