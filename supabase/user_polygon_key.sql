-- Fernet-encrypted Polygon.io API keys; accessed only via FastAPI (service role), not from the browser client.
create table if not exists public.user_polygon_keys (
  user_id uuid not null primary key references auth.users (id) on delete cascade,
  key_cipher text not null,
  updated_at timestamptz not null default now()
);

comment on table public.user_polygon_keys is 'Polygon API key ciphertext (Fernet). Plain key never stored; encrypt with server POLYGON_ENCRYPTION_KEY.';

alter table public.user_polygon_keys enable row level security;

-- Block PostgREST direct access; backend uses service role (bypasses RLS).
create policy "no direct client access"
  on public.user_polygon_keys
  for all
  using (false);
