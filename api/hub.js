// Backend do Delivery Hub — Eterniza. Protegido por token (ADMIN_TOKEN ou CAKTO_SECRET).
const { sbSelect, sbUpdate, sbInsert, sbDelete, normalizePhone } = require('./_lib');

const STATUSES = ['briefing_recebido', 'checkout_iniciado', 'recuperacao_pix', 'pago', 'fila_edicao', 'produzindo', 'pronta', 'entregue', 'erro'];
const RECOVERY = ['nao_contatado', 'contatado', 'sem_resposta', 'convertido', 'descartado'];
const COLS = 'id,created_at,updated_at,customer_name,customer_email,customer_phone,phone_normalized,recipient_name,relationship,memory,photo_url,video_url,delivery_message,delivered_at,valor,payment_status,status,pix_generated_at,recovery_ready,recovery_contact_status,recovery_notes,typebot_payload';

// Anti-bruteforce: 3 senhas erradas por IP -> trava 30s. In-memory (por instância serverless);
// só conta tentativa ERRADA — login certo e o auto-refresh (token válido) nunca disparam o bloqueio.
const FAILS = new Map(); // ip -> { n, windowStart, lockedUntil }
const MAX_FAILS = 3, LOCK_MS = 30000, WINDOW_MS = 60000;
const clientIp = (req) => ((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || 'unknown';

module.exports = async (req, res) => {
  const ADMIN = (process.env.ADMIN_TOKEN || process.env.CAKTO_SECRET || '').trim();
  const token = (req.headers['x-admin-token'] || req.query.token || '').toString().trim();
  const ip = clientIp(req), now = Date.now();
  if (FAILS.size > 1000) { for (const [k, v] of FAILS) if ((v.lockedUntil || 0) < now && (now - v.windowStart) > WINDOW_MS) FAILS.delete(k); }
  const rec = FAILS.get(ip);
  // IP travado?
  if (rec && rec.lockedUntil > now) {
    const retryAfter = Math.ceil((rec.lockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'too_many_attempts', retryAfter });
  }
  // senha errada -> conta a tentativa; ao atingir o limite, trava 30s
  if (!ADMIN || token !== ADMIN) {
    const r2 = (rec && (now - rec.windowStart) <= WINDOW_MS) ? rec : { n: 0, windowStart: now, lockedUntil: 0 };
    r2.n += 1;
    if (r2.n >= MAX_FAILS) {
      FAILS.set(ip, { n: 0, windowStart: now, lockedUntil: now + LOCK_MS });
      res.setHeader('Retry-After', String(LOCK_MS / 1000));
      return res.status(429).json({ error: 'too_many_attempts', retryAfter: LOCK_MS / 1000 });
    }
    FAILS.set(ip, r2);
    return res.status(401).json({ error: 'unauthorized', remaining: MAX_FAILS - r2.n });
  }
  if (rec) FAILS.delete(ip); // senha correta -> zera o contador do IP
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  const action = (req.query.action || 'list').toString();
  const id = (req.query.id || '').toString();

  try {
    if (action === 'list') {
      const rows = await sbSelect(`orders?select=${COLS}&order=created_at.desc&limit=500`);
      return res.status(200).json({ orders: Array.isArray(rows) ? rows : [] });
    }
    // análise do funil: junta funnel_events (landing+bot, sessões DISTINTAS) com orders (oferta->pago)
    if (action === 'analytics') {
      // Filtro por intervalo explícito (from/to em ISO, calculados no fuso do operador pelo front).
      // Prioriza from/to; senão cai no period (hoje/7d/30d/tudo) p/ retrocompat.
      const from = (req.query.from || '').toString().trim();
      const to = (req.query.to || '').toString().trim();
      const period = (req.query.period || '').toString();
      let f = '';
      if (from || to) {
        if (from) f += `&created_at=gte.${encodeURIComponent(from)}`;
        if (to) f += `&created_at=lt.${encodeURIComponent(to)}`;
      } else {
        const hours = period === 'hoje' ? 24 : period === '30d' ? 720 : period === 'tudo' ? null : period === '7d' ? 168 : 168;
        const since = hours ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null;
        if (since) f = `&created_at=gte.${encodeURIComponent(since)}`;
      }
      const evs = await sbSelect(`funnel_events?select=session_id,step${f}&limit=200000`).catch(() => []);
      // desde quando existe rastreamento (1º evento de todos os tempos) -> exibir "metrificando desde"
      const firstEv = await sbSelect(`funnel_events?select=created_at&order=created_at.asc&limit=1`).catch(() => []);
      const trackingSince = (Array.isArray(firstEv) && firstEv[0]) ? firstEv[0].created_at : null;
      const sets = {};
      for (const e of (Array.isArray(evs) ? evs : [])) { (sets[e.step] || (sets[e.step] = new Set())).add(e.session_id); }
      const ev = (s) => (sets[s] ? sets[s].size : 0);
      const ords = await sbSelect(`orders?select=status,created_at${f}&limit=100000`).catch(() => []);
      const list = Array.isArray(ords) ? ords : [];
      const PAID = ['pago', 'fila_edicao', 'produzindo', 'pronta', 'entregue'];
      const oferta = list.length;
      const pago = list.filter(o => PAID.includes(o.status)).length;
      const recuperacao = list.filter(o => o.status === 'recuperacao_pix').length;
      const LBL = { pagina_venda: 'Página de venda', cta_clicou: 'Clicou no CTA', g1_abertura: 'Bot · abertura', g2_porquem: 'Por quem', g3_nome: 'Nome', g4_memoria: 'Memória', g5_desejo: 'Desejo', g6_video: 'Viu o vídeo', g7_foto: 'Enviou a foto', g8_whatsapp: 'Deixou o WhatsApp' };
      const BOT = ['g1_abertura', 'g2_porquem', 'g3_nome', 'g4_memoria', 'g5_desejo', 'g7_foto', 'g8_whatsapp']; // g6_video removido do bot (24/06)
      // FUNIL = só sessões rastreadas (página de venda -> blocos do bot). Coerente e monotônico.
      const funnel = [
        { step: 'pagina_venda', label: LBL.pagina_venda, count: ev('pagina_venda') },
        { step: 'cta_clicou', label: LBL.cta_clicou, count: ev('cta_clicou') },
      ];
      for (const b of BOT) funnel.push({ step: b, label: LBL[b], count: ev(b) });
      // VENDAS = bloco separado (orders); base diferente (não entra no % do funil de sessões)
      return res.status(200).json({ funnel, sales: { oferta, pago, recuperacao }, period, from: from || null, to: to || null, trackingSince, botTracking: BOT.some(b => ev(b) > 0) });
    }
    // A/B Cakto x Yampi: atribuição (go_cakto/go_yampi) + vendas/faturamento por gateway (etiqueta cakto_payload._gateway)
    if (action === 'ab') {
      const from = (req.query.from || '').toString().trim();
      const to = (req.query.to || '').toString().trim();
      const period = (req.query.period || '').toString();
      let f = '';
      if (from || to) {
        if (from) f += `&created_at=gte.${encodeURIComponent(from)}`;
        if (to) f += `&created_at=lt.${encodeURIComponent(to)}`;
      } else {
        const hours = period === 'hoje' ? 24 : period === '30d' ? 720 : period === 'tudo' ? null : period === '7d' ? 168 : 168;
        const since = hours ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null;
        if (since) f = `&created_at=gte.${encodeURIComponent(since)}`;
      }
      // denominador: sessões DISTINTAS mandadas pra cada gateway
      const evs = await sbSelect(`funnel_events?select=session_id,step&step=in.(go_cakto,go_yampi)${f}&limit=200000`).catch(() => []);
      const aset = { cakto: new Set(), yampi: new Set() };
      for (const e of (Array.isArray(evs) ? evs : [])) { (e.step === 'go_yampi' ? aset.yampi : aset.cakto).add(e.session_id); }
      // vendas: pega só o gateway do jsonb (leve), status e valor
      const ords = await sbSelect(`orders?select=status,valor,gw:cakto_payload->>_gateway${f}&limit=100000`).catch(() => []);
      const PAID = ['pago', 'fila_edicao', 'produzindo', 'pronta', 'entregue'];
      const out = {
        cakto: { assigned: aset.cakto.size, paid: 0, recuperacao: 0, revenue: 0 },
        yampi: { assigned: aset.yampi.size, paid: 0, recuperacao: 0, revenue: 0 },
      };
      for (const o of (Array.isArray(ords) ? ords : [])) {
        const gw = (o.gw === 'yampi') ? 'yampi' : 'cakto'; // sem etiqueta (legado) = cakto
        if (PAID.includes(o.status)) { out[gw].paid++; out[gw].revenue += Number(o.valor) || 0; }
        else if (o.status === 'recuperacao_pix') out[gw].recuperacao++;
      }
      for (const k of ['cakto', 'yampi']) {
        const s = out[k];
        s.conversion = s.assigned ? +(100 * s.paid / s.assigned).toFixed(1) : null;       // % venda/visitante
        s.rev_per_visitor = s.assigned ? +(s.revenue / s.assigned).toFixed(2) : null;       // R$ por visitante (KPI principal)
        s.ticket = s.paid ? +(s.revenue / s.paid).toFixed(2) : null;                         // ticket médio (mostra efeito do bump)
        s.revenue = +s.revenue.toFixed(2);
      }
      return res.status(200).json({ ab: out, period: period || null, from: from || null, to: to || null });
    }
    if (action === 'update') {
      const status = (req.query.status || '').toString();
      if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: 'bad_params' });
      const patch = { status };
      if (status === 'entregue') patch.delivered_at = new Date().toISOString();
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, patch);
      return res.status(200).json({ ok: true });
    }
    if (action === 'set_video') {
      const video_url = (req.query.video_url || '').toString().trim();
      if (!id) return res.status(400).json({ error: 'bad_params' });
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, { video_url: video_url || null });
      return res.status(200).json({ ok: true });
    }
    if (action === 'recovery') {
      const rc = (req.query.recovery_contact_status || '').toString();
      if (!id || !RECOVERY.includes(rc)) return res.status(400).json({ error: 'bad_params' });
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, { recovery_contact_status: rc });
      return res.status(200).json({ ok: true });
    }
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'bad_params' });
      await sbDelete('orders', `id=eq.${encodeURIComponent(id)}`);
      return res.status(200).json({ ok: true });
    }
    // limpa eventos de funil de uma sessão (teste/limpeza)
    if (action === 'purge_track') {
      const sid = (req.query.sid || '').toString().trim();
      if (!sid) return res.status(400).json({ error: 'bad_params' });
      await sbDelete('funnel_events', `session_id=eq.${encodeURIComponent(sid)}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'seed') {
      await sbInsert('orders', {
        customer_name: 'PEDIDO TESTE (apague)', customer_email: 'teste@eterniza.com',
        customer_phone: '(11) 99999-0000', phone_normalized: '5511999990000',
        recipient_name: 'Vovó Teste', relationship: 'avó', memory: 'O abraço dela todo Natal na varanda.',
        photo_url: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&q=80',
        valor: 49.9, payment_status: 'paid', status: 'pago', cakto_payload: { teste: true },
      }, 'return=minimal');
      return res.status(200).json({ ok: true });
    }
    // importa histórico (CSV do form antigo). UPSERT por telefone: enriquece vendas
    // já pagas com foto/dados, insere leads novos. Não rebaixa status já avançado.
    if (action === 'import') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const rows = (b && b.rows) || [];
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows_invalido' });
      let inserted = 0, merged = 0, skipped = 0;
      for (const row of rows) {
        try {
          const pn = row.phone_normalized || null;
          const fields = {
            recipient_name: row.recipient_name || undefined,
            relationship: row.relationship || undefined,
            memory: row.memory || undefined,
            photo_url: row.photo_url || undefined,
            customer_phone: row.customer_phone || undefined,
            phone_normalized: pn || undefined,
            created_at: row.created_at || undefined,
            status: row.status || 'briefing_recebido',
            typebot_payload: { imported: true, source: 'form-antigo-csv', objetivo: row.objetivo || null },
          };
          Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);
          let existing = [];
          if (pn) existing = await sbSelect(`orders?phone_normalized=eq.${encodeURIComponent(pn)}&select=id,status&limit=1`);
          if (existing.length) {
            const patch = { ...fields };
            delete patch.created_at; // preserva a data do pedido existente
            if (['pago', 'entregue', 'pronta', 'produzindo', 'fila_edicao'].includes(existing[0].status)) delete patch.status;
            await sbUpdate('orders', `id=eq.${existing[0].id}`, patch);
            merged++;
          } else {
            await sbInsert('orders', fields, 'return=minimal');
            inserted++;
          }
        } catch (e) { skipped++; }
      }
      return res.status(200).json({ ok: true, inserted, merged, skipped });
    }

    // edição manual (admin): corrige campos do pedido. Whitelist + normaliza.
    if (action === 'edit') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      if (!id || !b || typeof b !== 'object') return res.status(400).json({ error: 'bad_params' });
      const allowed = ['customer_name', 'customer_email', 'customer_phone', 'recipient_name', 'relationship', 'memory', 'photo_url', 'video_url'];
      const patch = {};
      for (const k of allowed) {
        if (k in b) { let v = b[k]; if (typeof v === 'string') { v = v.trim(); if (v === '') v = null; } patch[k] = v; }
      }
      if ('valor' in b) { const n = Number(String(b.valor).replace(',', '.')); patch.valor = (b.valor === '' || b.valor == null || isNaN(n)) ? null : n; }
      if ('status' in b && b.status) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad_status' });
        patch.status = b.status;
        if (b.status === 'entregue') patch.delivered_at = new Date().toISOString();
      }
      if ('customer_phone' in patch) patch.phone_normalized = normalizePhone(patch.customer_phone);
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada_para_atualizar' });
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, patch);
      return res.status(200).json({ ok: true });
    }

    if (action === 'raw') {
      const phone = (req.query.phone || '').toString();
      const rows = await sbSelect(`orders?phone_normalized=eq.${encodeURIComponent(phone)}&select=id,status,cakto_payload,typebot_payload&limit=3`);
      return res.status(200).json({ rows });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String(e.message || e).slice(0, 300) });
  }
};
