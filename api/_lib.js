// Helpers compartilhados das funções serverless do Eterniza (Delivery Hub — Eterniza).
// Arquivo começa com _ => o Vercel NÃO trata como rota, mas pode ser require()ado.
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });

// telefone BR -> 55DDXXXXXXXXX (chave de busca/idempotência entre lead e venda)
function normalizePhone(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12 && d.length <= 13) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  if (d.length > 13) return d.slice(-13);
  return d.startsWith('55') ? d : '55' + d;
}

const getByPath = (src, path) => path.split('.').reduce((c, k) => (c && typeof c === 'object' ? c[k] : undefined), src);
const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? null;
const firstOf = (src, paths) => { for (const p of paths) { const v = getByPath(src, p); if (v !== undefined && v !== null && v !== '') return v; } return null; };

async function sbSelect(query) {
  const r = await fetch(`${SB}/rest/v1/${query}`, { headers: H() });
  if (!r.ok) throw new Error('sb_select:' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbInsert(table, row, prefer) {
  const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...H(), Prefer: prefer || 'return=representation' }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error('sb_insert:' + (await r.text()).slice(0, 200));
  return r.json().catch(() => null);
}
async function sbUpdate(table, filter, patch) {
  const r = await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { ...H(), Prefer: 'return=representation' }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error('sb_update:' + (await r.text()).slice(0, 200));
  return r.json().catch(() => null);
}
async function sbDelete(table, filter) {
  const r = await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { ...H(), Prefer: 'return=minimal' } });
  if (!r.ok) throw new Error('sb_delete:' + (await r.text()).slice(0, 200));
  return true;
}

// detecção de evento do Cakto -> qual status aplicar
function detectCaktoStatus(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const ev = String(pick(rec.event, rec.type, rec.action, getByPath(rec, 'data.event')) || '').toLowerCase();
  const st = String(pick(rec.status, getByPath(rec, 'data.status'), getByPath(rec, 'order.status'), getByPath(rec, 'payment.status')) || '').toLowerCase();
  if (ev.includes('paid') || ev.includes('approved') || ev.includes('completed') || ['paid', 'approved', 'completed', 'confirmed', 'aprovado', 'pago'].includes(st)) return 'pago';
  if (ev.includes('pix') || ev.includes('waiting') || ['waiting_payment', 'waiting', 'pending', 'pix'].includes(st)) return 'recuperacao_pix';
  if (ev.includes('checkout') || st.includes('checkout')) return 'checkout_iniciado';
  return null;
}

// Gera variações do telefone p/ casar form×checkout: trata o 9º dígito do celular
// (com/sem o 9 depois do DDD), além do +55 já normalizado. Ex: 5511999998888 <-> 551199998888.
function phoneCandidates(pn) {
  if (!pn) return [];
  const set = new Set([pn]);
  if (pn.startsWith('55') && pn.length >= 12) {
    const ddd = pn.slice(2, 4), local = pn.slice(4);
    if (local.length === 9 && local[0] === '9') set.add('55' + ddd + local.slice(1)); // tira o 9
    else if (local.length === 8) set.add('55' + ddd + '9' + local);                   // põe o 9
  }
  return [...set];
}

// upsert por telefone (fallback email) — preserva campos não enviados (PATCH parcial).
// Casa por QUALQUER variação do telefone (9º dígito), pois form e checkout divergem.
async function upsertOrder({ phone_normalized, email, fields, newStatus }) {
  let existing = [];
  if (phone_normalized) {
    const cands = phoneCandidates(phone_normalized);
    existing = await sbSelect(`orders?phone_normalized=in.(${cands.join(',')})&select=id,status,phone_normalized&limit=1`);
  } else if (email) existing = await sbSelect(`orders?customer_email=eq.${encodeURIComponent(email)}&select=id,status,phone_normalized&limit=1`);

  if (existing && existing.length) {
    const ex = existing[0];
    const update = (patch) => {
      const p = { ...patch };
      // mantém o telefone mais completo (com o 9º dígito) — wa.me precisa do número certo
      if (ex.phone_normalized && p.phone_normalized && p.phone_normalized.length < ex.phone_normalized.length) delete p.phone_normalized;
      return sbUpdate('orders', `id=eq.${ex.id}`, p);
    };
    return { id: ex.id, status: ex.status, phone: ex.phone_normalized, existed: true, update };
  }
  const row = { ...fields };
  if (newStatus) row.status = newStatus;
  await sbInsert('orders', row, 'return=minimal');
  return { existed: false };
}

module.exports = { SB, KEY, H, normalizePhone, phoneCandidates, getByPath, pick, firstOf, sbSelect, sbInsert, sbUpdate, sbDelete, detectCaktoStatus, upsertOrder };
