-- Run in Supabase SQL: manual MAE/MFE (max adverse / favorable excursion) per trade.
alter table public.trade_meta
  add column if not exists mae double precision null,
  add column if not exists mfe double precision null;

comment on column public.trade_meta.mae is 'Maximum adverse excursion ($), worst move against the position while open';
comment on column public.trade_meta.mfe is 'Maximum favorable excursion ($), best move in favor while open';
