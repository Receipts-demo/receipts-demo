-- Receipts App Schema
-- Run this in the Supabase SQL editor

-- Profiles (extends Supabase auth.users)
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz default now()
);

-- Projects
create table projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references profiles(id) on delete restrict,
  created_at  timestamptz default now()
);

-- Project membership (many users <-> many projects)
create table project_members (
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  joined_at   timestamptz default now(),
  primary key (project_id, user_id)
);

-- Tags (type distinguishes tool tags from project tags)
create table tags (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  type  text not null check (type in ('tool', 'project')),
  unique (name, type)
);

-- Entries (core log records)
create table entries (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references profiles(id) on delete restrict,
  project_id      uuid not null references projects(id) on delete restrict,
  recorded_at     timestamptz default now(),
  raw_transcript  text,
  claim           text,
  created_at      timestamptz default now()
);

-- Entry <-> Tag join table
create table entry_tags (
  entry_id  uuid not null references entries(id) on delete cascade,
  tag_id    uuid not null references tags(id) on delete cascade,
  primary key (entry_id, tag_id)
);

-- Indexes for common lookups
create index on entries (project_id);
create index on entries (owner_id);
create index on entries (recorded_at desc);
create index on project_members (user_id);
