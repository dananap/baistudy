#!/usr/bin/env bash
# Deploy the Supabase scheduled study-reminder function.
#
# Prerequisites:
#   - Supabase CLI authenticated and linked: supabase link --project-ref <ref>
#   - Existing VAPID values configured as function secrets:
#       supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
#         VAPID_SUBJECT=mailto:admin@example.com
#   - Vault secrets created in the SQL editor (replace both values):
#       select vault.create_secret(
#         'https://<project-ref>.supabase.co/functions/v1/study-reminders',
#         'study_reminders_url'
#       );
#       select vault.create_secret(
#         '<default-supabase-secret-key>',
#         'study_reminders_secret_key'
#       );
#   - Apply this script only after the function and both Vault secrets exist.
#   - Deploy the backend first: it creates push_subscriptions, study_days and
#     reminder_deliveries on boot, and the RLS migration fails without them.
#
# Usage: bash deploy-study-reminders.sh

set -euo pipefail

cd "$(dirname "$0")"
supabase functions deploy study-reminders
supabase db push
