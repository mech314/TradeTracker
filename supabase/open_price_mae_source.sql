-- Run once in Supabase SQL editor (after trade_meta MAE/MFE columns exist).

alter table public.round_trips
  add column if not exists open_price double precision null;

comment on column public.round_trips.open_price is 'Volume-weighted average entry price from fills (for Polygon MAE/MFE).';

alter table public.trade_meta
  add column if not exists mae_mfe_source text null;

comment on column public.trade_meta.mae_mfe_source is 'manual | polygon_auto — how MAE/MFE were set';
