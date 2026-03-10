-- ─── USER CATEGORIES TABLE ────────────────────────────────────────────────────
-- Run this in your Supabase SQL editor (Database > SQL Editor > New query)
--
-- Allows users to:
--   • Rename / re-icon system categories (personal, work, home, investment)
--   • Add custom categories (e.g. Groceries, Medical, Subscriptions)
--   • Hide any category from the Add form and History filters
--   • Mark a category as "savings/investment" type (shows warning in UI)

create table if not exists public.user_categories (
  id          text        primary key,                          -- system id OR "custom_xxx"
  user_id     uuid        not null references auth.users(id) on delete cascade,
  label       text        not null,
  icon        text        not null default '📦',
  hidden      bool        not null default false,
  is_savings  bool        not null default false,
  sort_order  int         not null default 0,
  created_at  timestamptz not null default now()
);

-- Row Level Security
alter table public.user_categories enable row level security;
create policy "user_categories_all" on public.user_categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime
alter publication supabase_realtime add table public.user_categories;
