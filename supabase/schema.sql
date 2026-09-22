-- supabase/schema.sql — cloud-sync server schema (KIEO-061).
--
-- Apply once in the Supabase SQL editor (or `supabase db push`). The app
-- itself never creates these tables; it only reads/writes rows owned by the
-- signed-in user through PostgREST, which enforces the RLS below.
--
-- Security posture (mirrors docs/03-Security-Access.md §3):
--   * RLS is ENABLED on every table with a deny-all default: no policy =
--     no access, for anyone including anon.
--   * One policy per operation (SELECT/INSERT/UPDATE/DELETE) per table, each
--     restricted to `auth.uid() = user_id`. No user can ever read or write
--     another user's rows — verify with two accounts before trusting this.
--   * API keys, conversation content, and tool args NEVER sync (the engine's
--     allowlist in agent-core/sync/engine.ts excludes them client-side too —
--     defense in depth).

create table if not exists public.synced_settings (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text not null,
  updated_at bigint not null,
  primary key (user_id, key)
);

create table if not exists public.synced_permissions (
  user_id uuid not null references auth.users (id) on delete cascade,
  action_type text not null,
  level text not null check (level in ('always_allow', 'ask_every_time', 'never_allow')),
  updated_at bigint not null,
  primary key (user_id, action_type)
);

create table if not exists public.synced_memory_facts (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  fact text not null,
  created_at bigint not null,
  edited_by_user integer not null default 0 check (edited_by_user in (0, 1)),
  updated_at bigint not null,
  primary key (user_id, id)
);

alter table public.synced_settings enable row level security;
alter table public.synced_permissions enable row level security;
alter table public.synced_memory_facts enable row level security;

-- Deny-all is the default once RLS is enabled; the policies below open
-- exactly owner access, nothing more. Dropped first for idempotent re-runs.
drop policy if exists "owner full access" on public.synced_settings;
create policy "owner full access" on public.synced_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner full access" on public.synced_permissions;
create policy "owner full access" on public.synced_permissions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner full access" on public.synced_memory_facts;
create policy "owner full access" on public.synced_memory_facts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
