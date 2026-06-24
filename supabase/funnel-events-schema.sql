-- ============================================================
-- ETERNIZA — Painel de Análise (funil bloco a bloco)
-- Rode UMA VEZ no SQL Editor do Supabase (projeto esfpllxkvyakjtxvlvco).
-- Guarda 1 linha por "sessão chegou num passo do funil". Sem dado pessoal:
-- só um id de sessão aleatório (sid), o nome do passo e a hora.
-- ============================================================

create table if not exists funnel_events (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  step        text not null,
  created_at  timestamptz not null default now()
);

-- índices para o painel (contagem por passo/período e distinct por sessão)
create index if not exists funnel_events_step_time on funnel_events (step, created_at desc);
create index if not exists funnel_events_session    on funnel_events (session_id);

-- RLS ligado, sem políticas públicas: só a service key (backend) acessa — igual `orders`.
alter table funnel_events enable row level security;
