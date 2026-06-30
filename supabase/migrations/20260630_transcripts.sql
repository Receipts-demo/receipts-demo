-- ============================================================
-- Transcripts table
-- Project: kxkynhbulfxkibwmwrwl (Central EU)
-- New object type alongside entries and projects.
-- Paste and run in Supabase SQL Editor (once only).
-- ============================================================


-- ------------------------------------------------------------
-- 1. projects.shared flag
--    Controls whether meeting transcripts on this project can
--    be marked shared with workspace members.
-- ------------------------------------------------------------
alter table public.projects
  add column if not exists shared boolean not null default false;


-- ------------------------------------------------------------
-- 2. Transcripts table
-- ------------------------------------------------------------
create table if not exists public.transcripts (
  id               uuid        primary key default gen_random_uuid(),
  owner_id         uuid        not null references auth.users(id) on delete cascade,
  project_id       uuid        references public.projects(id) on delete set null,
  transcript_type  text        not null check (transcript_type in ('meeting', 'personal_note')),
  title            text,
  summary          text,
  raw_text         text        not null,
  suggested_tags   text[]      not null default '{}',
  duration_seconds int,
  shared           boolean     not null default false,
  created_at       timestamptz not null default now()
);

grant select, insert, update, delete on public.transcripts to authenticated;
grant all on public.transcripts to service_role;

create index if not exists transcripts_project_id_idx on public.transcripts(project_id);
create index if not exists transcripts_owner_id_idx   on public.transcripts(owner_id);


-- ------------------------------------------------------------
-- 3. RLS
--
-- Two SELECT paths evaluated with OR:
--
--   A. Owner — always full CRUD on their own rows.
--
--   B. Workspace member — read-only when:
--        - transcript.shared = true
--        - caller is in the same workspace as the owner
--
--      Workspace membership is checked via a profiles self-join
--      (not via workspace_members) because workspace_members RLS
--      is a flat "user_id = auth.uid()" policy — querying it for
--      another user's membership returns nothing. profiles has
--      using(true) for authenticated users and is safe to join.
--
-- The project.shared flag is enforced at write time by the trigger
-- below, not in the SELECT policy. Checking projects here would
-- silently fail for workspace members who are not the project owner,
-- because the existing projects RLS only exposes status='Shipped'
-- rows to non-owners.
-- ------------------------------------------------------------
alter table public.transcripts enable row level security;

drop policy if exists "Owner can manage their own transcripts" on public.transcripts;
create policy "Owner can manage their own transcripts"
  on public.transcripts for all
  to authenticated
  using     (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "Workspace members can read shared transcripts" on public.transcripts;
create policy "Workspace members can read shared transcripts"
  on public.transcripts for select
  to authenticated
  using (
    shared = true
    and exists (
      select 1
      from   public.profiles viewer
      join   public.profiles owner
               on  owner.workspace_id  = viewer.workspace_id
               and owner.workspace_id  is not null
      where  viewer.id = auth.uid()
        and  owner.id  = transcripts.owner_id
    )
  );


-- ------------------------------------------------------------
-- 4. Trigger: enforce shared flag on every write
--
-- shared = true is only valid when:
--   a) transcript_type = 'meeting'  (personal_note is always private)
--   b) project_id is not null       (no project = no audience to scope to)
--   c) the parent project's shared flag = true
--
-- Runs BEFORE INSERT OR UPDATE — corrected value lands in the row.
-- Never raises an error; silently forces shared = false when
-- conditions aren't met. Application layer reads the returned row
-- and surfaces shared_forced_reason if needed.
--
-- Using a trigger rather than application-layer enforcement means
-- the rule holds for every write path: initial creation, a "share
-- this" toggle in the UI, a future edit endpoint, anything.
-- ------------------------------------------------------------
create or replace function public.enforce_transcript_shared_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  project_is_shared boolean;
begin
  -- personal_note is always private
  if new.transcript_type = 'personal_note' then
    new.shared := false;
    return new;
  end if;

  -- no project = no audience
  if new.project_id is null then
    new.shared := false;
    return new;
  end if;

  -- only query if shared = true is actually being requested
  if new.shared = true then
    select shared into project_is_shared
    from public.projects
    where id = new.project_id;

    if project_is_shared is not true then
      new.shared := false;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_transcript_shared_flag on public.transcripts;
create trigger enforce_transcript_shared_flag
  before insert or update on public.transcripts
  for each row execute function public.enforce_transcript_shared_flag();
