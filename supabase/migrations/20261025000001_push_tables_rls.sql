-- The backend creates these tables (SQLAlchemy create_all) in the public
-- schema, which PostgREST exposes to the anon key shipped in the frontend.
-- RLS with no policies denies anon/authenticated entirely; the backend (table
-- owner) and the study-reminders function (secret key) bypass it.
--
-- Deliberately not `if exists`: pushing this before the backend has booted and
-- created the tables should fail rather than silently leave them open.
alter table public.push_subscriptions enable row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.study_days enable row level security;
