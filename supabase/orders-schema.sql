-- ============================================================
-- ETERNIZA — Delivery Hub — Schema oficial
-- Rode UMA VEZ no SQL Editor do Supabase (projeto esfpllxkvyakjtxvlvco).
-- Tabela única `orders` = fonte de verdade do Hub + da página /acompanhar.
-- ============================================================
create extension if not exists "pgcrypto";

create table if not exists public.orders (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- ── contato (chave de busca/idempotência) ──
  phone_normalized          text,        -- 55DDXXXXXXXXX (chave principal)
  customer_phone            text,        -- telefone cru como recebido
  customer_email            text,
  customer_name             text,        -- nome do COMPRADOR

  -- ── dados da homenagem (vêm do Typebot/form) ──
  recipient_name            text,        -- nome do ente querido (homenageado)
  relationship              text,        -- parente (mãe, pai, ...)
  memory                    text,        -- lembrança/memória escolhida
  photo_url                 text,        -- FOTO enviada (chave pra produzir o vídeo)

  -- ── entrega ──
  video_url                 text,        -- vídeo final produzido
  delivery_message          text,
  delivered_at              timestamptz,

  -- ── financeiro / status ──
  valor                     numeric,     -- valor da venda (do Cakto)
  payment_status            text,        -- status cru do Cakto (paid, etc.)
  status                    text not null default 'briefing_recebido',
  -- valores: briefing_recebido | checkout_iniciado | recuperacao_pix | pago
  --          | fila_edicao | produzindo | pronta | entregue | erro

  -- ── recuperação de pix ──
  pix_generated_at          timestamptz,
  recovery_ready            boolean not null default false,
  recovery_contact_status   text default 'nao_contatado',
  recovery_notes            text,

  -- ── payloads brutos (auditoria) ──
  typebot_payload           jsonb,
  cakto_payload             jsonb,
  error_message             text
);

create unique index if not exists orders_phone_normalized_key
  on public.orders (phone_normalized) where phone_normalized is not null;
create index if not exists orders_status_idx     on public.orders (status);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_email_idx       on public.orders (lower(customer_email));

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- logs (auditoria/entrega)
create table if not exists public.integration_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  source text, event_type text, payload jsonb, status text, error_message text,
  created_at timestamptz not null default now()
);

-- RLS ligado, SEM políticas públicas: só o servidor (service role) acessa.
alter table public.orders           enable row level security;
alter table public.integration_logs enable row level security;
