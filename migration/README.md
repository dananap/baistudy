# Migration playbook

Run these in order. Each script is idempotent — safe to re-run.

## Prerequisites

- `flashcard-backend/venv` active with the new `requirements.txt` installed
  (we need `supabase` and `psycopg2-binary`).
- `pg_dump`, `pg_restore`, `psql` on PATH.
- A Supabase project provisioned. Note its URL, anon key, service-role key,
  JWT secret, and direct-connection DB URL.
- Firebase CLI authenticated against the current project for the user export.

## 1. Dump and restore the DB

```bash
SOURCE_URL='postgres://<current prod>'        \
TARGET_URL='postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres'  \
bash migration/01_dump_restore_db.sh
```

After this completes, point the still-on-Cloud-Run backend at Supabase by
updating `DATABASE_URL` to the **pooled** URL (port 6543, `sslmode=require`).
Smoke-test the app — auth still goes through Firebase here, so this step is
fully reversible if the restore looks wrong.

## 2. Migrate audio + image blobs to Supabase Storage

Buckets are created automatically by the script.

```bash
SUPABASE_URL='https://<ref>.supabase.co'           \
SUPABASE_SERVICE_ROLE_KEY='<service-role-key>'     \
DATABASE_URL='postgresql+psycopg2://postgres:<password>@aws-...pooler.supabase.com:6543/postgres?sslmode=require'  \
python migration/02_migrate_blobs.py
```

Run a `VACUUM FULL word_audio, word_images;` in the Supabase SQL editor
afterwards to actually reclaim the freed space.

## 3. Export Firebase users and pre-create Supabase users

```bash
firebase auth:export firebase-users.json --project=baistudy

SUPABASE_URL='...'              \
SUPABASE_SERVICE_ROLE_KEY='...' \
DATABASE_URL='postgresql+psycopg2://...'  \
python migration/03_import_users.py --firebase-export firebase-users.json --dry-run

# Looks good? Drop --dry-run and re-run.
```

This populates `auth.users` and backfills `public.users.supabase_uid`.

## 4. Trigger the password-reset emails

```bash
SUPABASE_URL='...'              \
SUPABASE_SERVICE_ROLE_KEY='...' \
REDIRECT_URL='https://baistudy.pages.dev/login'  \
python migration/04_send_reset_emails.py --firebase-export firebase-users.json
```

## 5. Deploy + cut over

```bash
bash deploy-backend.sh
bash deploy-frontend.sh
```

After verification, delete `firebase-users.json` (contains password hashes
and PII) and revoke any Firebase admin credentials.
