// ============================================================================
// Backend do Delivery Hub — Eterniza (função serverless única, roteada por ?action=).
// ----------------------------------------------------------------------------
// Segurança: TODA request exige token (ADMIN_TOKEN ou CAKTO_SECRET) no header
//   x-admin-token (ou ?token=). Anti-bruteforce in-memory por IP (3 erros → trava 30s).
//   Toda entrada do usuário vai encodeURIComponent() nos filtros PostgREST (sem injeção).
// Ações (req.query.action):
//   list ............. lista pedidos (fallback de colunas opcionais p/ migrations pendentes)
//   analytics/ab/quiz_ab  dashboards de funil e A/B (lê funnel_events + orders)
//   update/edit/set_video assign/recovery  mutações de 1 pedido
//   add_photo/del_photo/set_main_photo  galeria de fotos do lead (bucket público)
//   import/seed/delete/purge_empty_leads/purge_track  manutenção/admin
//   watest/discord_test/raw  diagnósticos (não tocam dados de produção, exceto seed)
// Resposta: sempre JSON; erro inesperado cai no catch geral → 500 { error, detail }.
// ============================================================================
const { sbSelect, sbUpdate, sbInsert, sbDelete, normalizePhone, getByPath, pick, SB, KEY } = require('./_lib');
const wa = require('./_whatsapp');

const STATUSES = ['briefing_recebido', 'checkout_iniciado', 'recuperacao_pix', 'pago', 'fila_edicao', 'produzindo', 'pronta', 'entregue', 'erro'];
const RECOVERY = ['nao_contatado', 'contatado', 'sem_resposta', 'convertido', 'descartado'];
const COLS = 'id,created_at,updated_at,customer_name,customer_email,customer_phone,phone_normalized,recipient_name,relationship,memory,photo_url,photos,video_url,delivery_message,delivered_at,valor,payment_status,status,pix_generated_at,recovery_ready,recovery_contact_status,recovery_notes,typebot_payload,attendant,attendant_at,wa_confirm_sent_at';
// colunas adicionadas por migration — se ainda não existirem no banco, o list cai num retry sem elas
const OPTIONAL_COLS = ['attendant', 'attendant_at', 'wa_confirm_sent_at'];

// Anti-bruteforce: 3 senhas erradas por IP -> trava 30s. In-memory (por instância serverless);
// só conta tentativa ERRADA — login certo e o auto-refresh (token válido) nunca disparam o bloqueio.
const FAILS = new Map(); // ip -> { n, windowStart, lockedUntil }
const MAX_FAILS = 3, LOCK_MS = 30000, WINDOW_MS = 60000;
const clientIp = (req) => ((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || 'unknown';

// ---- Galeria de fotos do lead (Feature B) — sobe no bucket público 'previas' (mesmo do preview.js) ----
const PHOTO_BUCKET = 'previas';
const SBH = (extra) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...(extra || {}) });
async function ensurePhotoBucket() {
  await fetch(`${SB}/storage/v1/bucket`, {
    method: 'POST', headers: SBH({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: PHOTO_BUCKET, name: PHOTO_BUCKET, public: true }),
  }).catch(() => {});
}
async function uploadLeadPhoto(base64, mime) {
  const ext = (String(mime).split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('+xml', '');
  const path = `lead-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(base64, 'base64');
  const put = () => fetch(`${SB}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST', headers: SBH({ 'Content-Type': mime, 'x-upsert': 'true' }), body: bytes,
  });
  let up = await put();
  if (up.status === 404 || up.status === 400) { await ensurePhotoBucket(); up = await put(); }
  if (!up.ok) throw new Error('storage_' + up.status + ':' + (await up.text()).slice(0, 180));
  return `${SB}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
}

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
      // tenta com COLS completo; se uma coluna opcional ainda não existe (migration pendente),
      // retira ela e tenta de novo. Robusto a qualquer combinação de migrations pendentes.
      let cols = COLS, rows;
      for (let attempt = 0; attempt < OPTIONAL_COLS.length + 1; attempt++) {
        try { rows = await sbSelect(`orders?select=${cols}&order=created_at.desc&limit=500`); break; }
        catch (e) {
          const msg = String(e.message || e);
          const miss = OPTIONAL_COLS.find(c => msg.includes(c) && cols.split(',').includes(c));
          if (miss) { cols = cols.split(',').filter(c => c !== miss).join(','); continue; }
          throw e;
        }
      }
      return res.status(200).json({ orders: Array.isArray(rows) ? rows : [] });
    }
    // teste do disparo automático de WhatsApp — manda a confirmação pro número informado.
    // protegido pelo token do hub. Ex.: ?action=watest&to=5511999999999&nome=Lucas
    if (action === 'watest') {
      const to = (req.query.to || '').toString().trim();
      if (!to) return res.status(400).json({ error: 'bad_params', hint: 'use ?to=5511999999999' });
      const nome = (req.query.nome || 'Lucas').toString();
      const recipient = (req.query.recipient || 'Vovó Teste').toString();
      const r = await wa.enviarConfirmacao({ phone: to, nome, recipient_name: recipient });
      return res.status(200).json({ ok: !!(r && r.ok), result: r });
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
      // FUNIL /homenagem (prévia inline, sem bot)
      const H_LBL = { h_hero: 'Página /homenagem', h_quiz: 'Clicou CTA hero', h_nome: 'Passou Q1 (pra quem)', h_memoria: 'Passou Q2 (nome)', h_whatsapp: 'Deixou WhatsApp', h_foto: 'Enviou foto', h_previa: 'Prévia gerada', h_checkout: 'Clicou finalizar' };
      const HOMENAGEM = ['h_hero', 'h_quiz', 'h_nome', 'h_memoria', 'h_whatsapp', 'h_foto', 'h_previa', 'h_checkout'];
      const funnelH = HOMENAGEM.map(s => ({ step: s, label: H_LBL[s], count: ev(s) }));
      // VENDAS = bloco separado (orders); base diferente (não entra no % do funil de sessões)
      return res.status(200).json({ funnel, funnelH, sales: { oferta, pago, recuperacao }, period, from: from || null, to: to || null, trackingSince, botTracking: BOT.some(b => ev(b) > 0) });
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
    // A/B do quiz: CTA da landing -> Typebot vs /homenagem começando direto na 1ª pergunta.
    if (action === 'quiz_ab') {
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

      const steps = [
        'go_typebot', 'go_homenagem', 'go_yampi', 'go_cakto',
        'g1_abertura', 'g2_porquem', 'g7_foto', 'g8_whatsapp',
        'h_quiz', 'h_nome', 'h_memoria', 'h_whatsapp', 'h_foto', 'h_previa', 'h_checkout',
      ];
      const evs = await sbSelect(`funnel_events?select=session_id,step&step=in.(${steps.join(',')})${f}&limit=200000`).catch(() => []);
      const sets = {};
      for (const e of (Array.isArray(evs) ? evs : [])) {
        (sets[e.step] || (sets[e.step] = new Set())).add(e.session_id);
      }
      const setOf = (step) => sets[step] || new Set();
      const countIn = (base, step) => {
        const target = setOf(step);
        let n = 0;
        for (const sid of base) if (target.has(sid)) n++;
        return n;
      };
      // /homenagem é tráfego DIRETO (split removido em 26/06): não dispara mais `go_homenagem`.
      // Âncora real da sessão = 1º toque no funil da página (h_hero direto, ou h_quiz se START_AT_QUIZ).
      // Mantém go_homenagem p/ não perder as sessões legadas do A/B antigo.
      const homenagemSet = new Set();
      for (const step of ['go_homenagem', 'h_hero', 'h_quiz']) for (const sid of setOf(step)) homenagemSet.add(sid);
      const assigned = {
        typebot: setOf('go_typebot'),
        homenagem: homenagemSet,
      };
      const out = {
        typebot: {
          assigned: assigned.typebot.size,
          started: countIn(assigned.typebot, 'g1_abertura'),
          answered1: countIn(assigned.typebot, 'g2_porquem'),
          whatsapp: countIn(assigned.typebot, 'g8_whatsapp'),
          photo: countIn(assigned.typebot, 'g7_foto'),
          preview: null,
          checkout: 0, // calculado abaixo (evento de página ∪ pedido que chegou ao pagamento)
          leads: 0, paid: 0, recuperacao: 0, revenue: 0,
        },
        homenagem: {
          assigned: assigned.homenagem.size,
          started: countIn(assigned.homenagem, 'h_quiz'),
          answered1: countIn(assigned.homenagem, 'h_nome'),
          whatsapp: countIn(assigned.homenagem, 'h_whatsapp'),
          photo: countIn(assigned.homenagem, 'h_foto'),
          preview: countIn(assigned.homenagem, 'h_previa'),
          checkout: 0, // calculado abaixo
          leads: 0, paid: 0, recuperacao: 0, revenue: 0,
        },
      };

      // CHECKOUT (InitiateCheckout) por SID, robusto a 2 falhas:
      //  (a) o bot NÃO repassa o sid da landing pro ir-checkout -> go_yampi/go_cakto não casam com go_typebot;
      //  (b) /homenagem usa h_checkout (mesmo domínio, sid sempre casa).
      // Por isso unimos: sinal de EVENTO de página + sinal de PEDIDO que chegou ao pagamento (pix/pago).
      const coSids = { typebot: new Set(), homenagem: new Set() };
      for (const sid of setOf('h_checkout')) if (assigned.homenagem.has(sid)) coSids.homenagem.add(sid);
      for (const step of ['go_yampi', 'go_cakto']) for (const sid of setOf(step)) {
        if (assigned.homenagem.has(sid)) coSids.homenagem.add(sid);
        else if (assigned.typebot.has(sid)) coSids.typebot.add(sid);
      }

      const extractSid = (o) => {
        const tp = o.typebot_payload || {};
        const cp = o.cakto_payload || {};
        return pick(
          tp.sid,
          tp.session_id,
          tp.sessionId,
          getByPath(tp, 'queryParams.sid'),
          getByPath(tp, 'variables.sid'),
          getByPath(cp, 'resource.metadata.sid'),
          getByPath(cp, 'metadata.sid'),
          getByPath(cp, 'data.metadata.sid'),
        );
      };
      const ords = await sbSelect(`orders?select=id,status,valor,typebot_payload,cakto_payload${f}&limit=100000`).catch(() => []);
      const PAID = ['pago', 'fila_edicao', 'produzindo', 'pronta', 'entregue'];
      // pedido chegou ao checkout = gerou pix OU pagou (sinal de pedido p/ complementar o evento de página)
      const REACHED_CO = ['checkout_iniciado', 'recuperacao_pix', ...PAID];
      for (const o of (Array.isArray(ords) ? ords : [])) {
        const sid = extractSid(o);
        // `source==='homenagem'` é gravado no lead da página -> atribuição definitiva, à prova de sid.
        const isHomenagem = (o.typebot_payload || {}).source === 'homenagem';
        // Atribuição à prova de sid: homenagem é DEFINITIVA (source gravado no lead da página);
        // TODO o resto cai no Typebot (funil do bot, dominante). NUNCA descarta o pedido — o bot
        // não propaga o sid da landing, então exigir sid perdia venda/checkout (bug corrigido 29/06).
        const side = isHomenagem ? 'homenagem'
          : sid && assigned.homenagem.has(sid) ? 'homenagem'
          : 'typebot';
        const s = out[side];
        s.leads++;
        if (PAID.includes(o.status)) { s.paid++; s.revenue += Number(o.valor) || 0; }
        else if (o.status === 'recuperacao_pix') s.recuperacao++;
        // checkout = pedido que chegou ao pagamento; dedup por sid (quando há) OU pelo id do pedido.
        if (REACHED_CO.includes(o.status)) coSids[side].add(sid || ('ord:' + o.id));
      }
      out.typebot.checkout = coSids.typebot.size;
      out.homenagem.checkout = coSids.homenagem.size;
      for (const k of ['typebot', 'homenagem']) {
        const s = out[k];
        s.started_rate = s.assigned ? +(100 * s.started / s.assigned).toFixed(1) : null;
        s.whatsapp_rate = s.assigned ? +(100 * s.whatsapp / s.assigned).toFixed(1) : null;
        s.photo_rate = s.assigned ? +(100 * s.photo / s.assigned).toFixed(1) : null;
        s.checkout_rate = s.assigned ? +(100 * s.checkout / s.assigned).toFixed(1) : null;
        s.conversion = s.assigned ? +(100 * s.paid / s.assigned).toFixed(1) : null;
        s.rev_per_visitor = s.assigned ? +(s.revenue / s.assigned).toFixed(2) : null;
        s.ticket = s.paid ? +(s.revenue / s.paid).toFixed(2) : null;
        s.revenue = +s.revenue.toFixed(2);
      }
      return res.status(200).json({ quizAb: out, period: period || null, from: from || null, to: to || null });
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
    // ---- Galeria de fotos (Feature B): anexa, remove e define capa. NUNCA perde foto antiga. ----
    // add_photo: recebe a imagem (data-URL base64 no body) -> sobe no Storage -> ANEXA no array `photos`.
    if (action === 'add_photo') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      if (!id || !b || typeof b !== 'object') return res.status(400).json({ error: 'bad_params' });
      const dataUrl = (b.image || b.photo || b.fotoB64 || '').toString();
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      const base64 = m ? m[2] : dataUrl;
      const mime = m ? m[1] : 'image/jpeg';
      if (!base64) return res.status(400).json({ error: 'image_missing' });
      let url;
      try { url = await uploadLeadPhoto(base64, mime); }
      catch (e) { return res.status(500).json({ error: 'upload_failed', detail: String(e.message || e).slice(0, 200) }); }
      const cur = await sbSelect(`orders?id=eq.${encodeURIComponent(id)}&select=photos,photo_url&limit=1`);
      const row = (Array.isArray(cur) && cur[0]) || {};
      const photos = Array.isArray(row.photos) ? row.photos.slice() : [];
      photos.push(url);
      const patch = { photos };
      if (!row.photo_url) patch.photo_url = url; // 1ª foto vira a capa (compat com quem lê photo_url)
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, patch);
      return res.status(200).json({ ok: true, url, photos, photo_url: patch.photo_url || row.photo_url || null });
    }
    // del_photo: tira a foto do array (NÃO apaga do Storage — barato e reversível). Promove a capa se preciso.
    if (action === 'del_photo') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const url = (req.query.url || (b && b.url) || '').toString();
      if (!id || !url) return res.status(400).json({ error: 'bad_params' });
      const cur = await sbSelect(`orders?id=eq.${encodeURIComponent(id)}&select=photos,photo_url&limit=1`);
      const row = (Array.isArray(cur) && cur[0]) || {};
      const photos = (Array.isArray(row.photos) ? row.photos : []).filter(u => u !== url);
      const patch = { photos };
      if (row.photo_url === url) patch.photo_url = photos[0] || null; // deletou a capa -> promove a próxima
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, patch);
      return res.status(200).json({ ok: true, photos, photo_url: ('photo_url' in patch) ? patch.photo_url : (row.photo_url || null) });
    }
    // set_main_photo: define qual foto é a capa (photo_url) — a usada no briefing/produção/entrega.
    if (action === 'set_main_photo') {
      const url = (req.query.url || '').toString();
      if (!id || !url) return res.status(400).json({ error: 'bad_params' });
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, { photo_url: url });
      return res.status(200).json({ ok: true, photo_url: url });
    }
    if (action === 'recovery') {
      const rc = (req.query.recovery_contact_status || '').toString();
      if (!id || !RECOVERY.includes(rc)) return res.status(400).json({ error: 'bad_params' });
      await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`, { recovery_contact_status: rc });
      return res.status(200).json({ ok: true });
    }
    if (action === 'assign') {
      const a = (req.query.attendant || '').toString();
      if (!id || !['', 'folha', 'davi'].includes(a)) return res.status(400).json({ error: 'bad_params' });
      try {
        await sbUpdate('orders', `id=eq.${encodeURIComponent(id)}`,
          { attendant: a || null, attendant_at: a ? new Date().toISOString() : null });
      } catch (e) {
        if (String(e.message || e).includes('attendant')) return res.status(503).json({ error: 'migration_pendente', detail: 'Rode a migration no Supabase antes de usar atribuição.' });
        throw e;
      }
      return res.status(200).json({ ok: true });
    }
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'bad_params' });
      await sbDelete('orders', `id=eq.${encodeURIComponent(id)}`);
      return res.status(200).json({ ok: true });
    }
    // Apaga leads sem nome do homenageado E sem nome do cliente (leads incompletos).
    // Protege: nunca deleta quem tem status além de briefing_recebido (pagou, pix etc.).
    if (action === 'purge_empty_leads') {
      const preview = req.query.preview === '1'; // ?preview=1 só conta, não deleta
      const rows = await sbSelect('orders?select=id,status,recipient_name,customer_name&recipient_name=is.null&customer_name=is.null&status=eq.briefing_recebido&limit=5000');
      const list = Array.isArray(rows) ? rows : [];
      if (preview) return res.status(200).json({ count: list.length, ids: list.map(r => r.id) });
      let deleted = 0;
      for (const r of list) {
        await sbDelete('orders', `id=eq.${encodeURIComponent(r.id)}`);
        deleted++;
      }
      return res.status(200).json({ ok: true, deleted });
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
      // 2º WhatsApp (casos de número errado/duplicado): guardado em recovery_notes como "tel2:<norm>" (campo livre, não usado p/ outra coisa)
      if ('phone2' in b) { const d = String(b.phone2 || '').replace(/\D/g, ''); patch.recovery_notes = d ? ('tel2:' + normalizePhone(d)) : null; }
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

    // teste do Discord (admin): dispara as 2 notificações reais (pix gerado + venda aprovada) SEM
    // tocar no banco nem no CAPI. ?only=pix dispara só o pix (sem pingar Davi/Folha). Retorna status+canal.
    if (action === 'discord_test') {
      const discord = require('./_discord');
      const only = (req.query.only || '').toString();
      const sample = { valor: 49.9, nome: '🧪 TESTE (pode ignorar)', phone: '5511999990000', email: 'teste@eterniza.com', gateway: 'Yampi (teste)', orderId: 'TESTE-DISCORD' };
      const pix_gerado = await discord.notifyPixGerado(sample); // 🧾 azul, NÃO pinga
      const venda_aprovada = (only === 'pix') ? { skipped: 'only=pix' } : await discord.notifyVendaAprovada(sample); // 🔥 laranja, PINGA todos da lista
      return res.status(200).json({ ok: true, webhook_configurado: !!process.env.DISCORD_WEBHOOK_URL, mention_ids: discord.MENTION_IDS, pix_gerado, venda_aprovada });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String(e.message || e).slice(0, 300) });
  }
};
