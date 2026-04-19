-- Run once in Supabase SQL editor: per-trade tags for dashboard filtering (stored with notes/meta).
alter table public.trade_meta
  add column if not exists tags text[] not null default '{}'::text[];
