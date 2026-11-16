-- Reference migration for the engineer connecting the Supabase Edge Function.
-- Run in the target project; this file does not provision or connect anything.
create table if not exists public.early_access_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254 and email = lower(trim(email))),
  platform text not null check (platform in ('ios', 'android', 'both')),
  source text not null check (source in ('landing-hero', 'landing-footer', 'landing-ios', 'landing-android')),
  consent boolean not null check (consent = true),
  consent_version text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists early_access_requests_email_unique on public.early_access_requests (email);
alter table public.early_access_requests enable row level security;
revoke all on public.early_access_requests from anon, authenticated;
-- The server-side Edge Function uses its private service credential to upsert.
-- Deliberately no anonymous select/insert policy and no browser service key.
