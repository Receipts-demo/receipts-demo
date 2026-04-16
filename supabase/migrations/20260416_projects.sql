-- ============================================================
-- Receipts Projects Migration
-- Project: kxkynhbulfxkibwmwrwl (Central EU)
-- Paste and run this in the Supabase SQL Editor (once only)
-- ============================================================


-- ------------------------------------------------------------
-- 1. Projects table
-- ------------------------------------------------------------
create table if not exists public.projects (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  one_liner  text,
  goal       text,
  status     text        not null default 'in_progress',
  created_at timestamptz default now()
);


-- ------------------------------------------------------------
-- 2. RLS: projects
-- ------------------------------------------------------------
alter table public.projects enable row level security;

drop policy if exists "Users can read their own projects" on public.projects;
create policy "Users can read their own projects"
  on public.projects for select
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "Users can create their own projects" on public.projects;
create policy "Users can create their own projects"
  on public.projects for insert
  to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "Users can update their own projects" on public.projects;
create policy "Users can update their own projects"
  on public.projects for update
  to authenticated
  using  (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "Users can delete their own projects" on public.projects;
create policy "Users can delete their own projects"
  on public.projects for delete
  to authenticated
  using (owner_id = auth.uid());


-- ------------------------------------------------------------
-- 3. Add project_id FK to entries (if not already present)
--    Nullable so existing entries are unaffected.
-- ------------------------------------------------------------
alter table public.entries
  add column if not exists project_id uuid references public.projects(id) on delete set null;
