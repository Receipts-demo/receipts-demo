-- Receipts App — Row Level Security Policies
-- Run this in the Supabase SQL editor after schema.sql

-- Enable RLS on all tables
alter table profiles        enable row level security;
alter table projects        enable row level security;
alter table project_members enable row level security;
alter table tags            enable row level security;
alter table entries         enable row level security;
alter table entry_tags      enable row level security;

-- Helper function: is the current user a member of a given project?
create or replace function is_project_member(p_project_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id
    and   user_id    = auth.uid()
  );
$$;

-- ============================================================
-- profiles
-- ============================================================
create policy "Authenticated users can read all profiles"
  on profiles for select to authenticated
  using (true);

create policy "Users can update their own profile"
  on profiles for update to authenticated
  using (id = auth.uid());

-- ============================================================
-- projects
-- ============================================================
create policy "Members can read their projects"
  on projects for select to authenticated
  using (is_project_member(id));

create policy "Authenticated users can create projects"
  on projects for insert to authenticated
  with check (created_by = auth.uid());

create policy "Project creators can update their projects"
  on projects for update to authenticated
  using (created_by = auth.uid());

-- ============================================================
-- project_members
-- ============================================================
create policy "Members can see who is in their projects"
  on project_members for select to authenticated
  using (is_project_member(project_id));

create policy "Project creators can add members"
  on project_members for insert to authenticated
  with check (
    exists (
      select 1 from projects
      where id         = project_id
      and   created_by = auth.uid()
    )
  );

create policy "Project creators can remove members"
  on project_members for delete to authenticated
  using (
    exists (
      select 1 from projects
      where id         = project_id
      and   created_by = auth.uid()
    )
  );

-- ============================================================
-- tags
-- ============================================================
create policy "Authenticated users can read tags"
  on tags for select to authenticated
  using (true);

create policy "Authenticated users can create tags"
  on tags for insert to authenticated
  with check (true);

-- ============================================================
-- entries
-- Read: anonymous entries (owner_id IS NULL) are public;
--       otherwise the reader must be a project member.
-- Write: users may only write their own entries.
-- ============================================================
create policy "Project members can read entries; anonymous entries are public"
  on entries for select
  using (
    owner_id is null
    or is_project_member(project_id)
  );

create policy "Users can create their own entries"
  on entries for insert to authenticated
  with check (owner_id = auth.uid());

create policy "Users can update their own entries"
  on entries for update to authenticated
  using (owner_id = auth.uid());

create policy "Users can delete their own entries"
  on entries for delete to authenticated
  using (owner_id = auth.uid());

-- ============================================================
-- entry_tags
-- Visibility follows entry visibility.
-- Write access requires owning the entry.
-- ============================================================
create policy "Entry tags visible if entry is visible"
  on entry_tags for select
  using (
    exists (
      select 1 from entries
      where id         = entry_id
      and   (owner_id is null or is_project_member(project_id))
    )
  );

create policy "Users can tag their own entries"
  on entry_tags for insert to authenticated
  with check (
    exists (
      select 1 from entries
      where id       = entry_id
      and   owner_id = auth.uid()
    )
  );

create policy "Users can remove tags from their own entries"
  on entry_tags for delete to authenticated
  using (
    exists (
      select 1 from entries
      where id       = entry_id
      and   owner_id = auth.uid()
    )
  );
