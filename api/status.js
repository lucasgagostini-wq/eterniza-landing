// Consulta pública do cliente (/acompanhar). Busca em `orders` por contato (email/WhatsApp).
// Server-side: não expõe foto nem payloads; só devolve o necessário pra timeline.
const { normalizePhone, phoneCandidates, sbSelect } = require('./_lib');

module.exports = async (req, res) => {
  const contato = (req.query.contato || '').toString().trim();
  if (!contato || contato.length < 5) return res.status(400).json({ error: 'contato_invalido' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  let filter;
  if (contato.includes('@')) {
    filter = `customer_email=eq.${encodeURIComponent(contato.toLowerCase())}`;
  } else {
    const p = normalizePhone(contato);
    if (!p) return res.status(400).json({ error: 'contato_invalido' });
    filter = `phone_normalized=in.(${phoneCandidates(p).join(',')})`;
  }

  try {
    const rows = await sbSelect(`orders?${filter}&select=id,customer_name,recipient_name,status,created_at,video_url&order=created_at.desc`);
    const pedidos = (rows || []).map(r => ({
      id: r.id,
      nome: r.recipient_name || r.customer_name || null,
      status: r.status,
      created_at: r.created_at,
      video_url: r.video_url || null,
    }));
    return res.status(200).json({ pedidos });
  } catch (e) {
    return res.status(500).json({ error: 'query_failed' });
  }
};
