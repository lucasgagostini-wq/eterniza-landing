
  /* ============================================================================
     DELIVERY HUB — Eterniza · front-end (vanilla JS, sem build/framework)
     ----------------------------------------------------------------------------
     SPA de 1 arquivo, servida estática pela Vercel; conversa SÓ com /api/hub
     (mesmo token do login, no header x-admin-token). É de propósito sem framework:
     a ferramenta precisa ser editável na unha, à prova de balas e leve no celular.

     Mapa do arquivo (de cima pra baixo):
       • Estado global ........ token, ORDERS[], FILTER, selId, datas, ATT_FILTER
       • Constantes/UI ........ TAG (status→cor), ATT (atendente), FILTERS, mensagens
       • Helpers .............. esc/fmt/money/waLink, copyText (cópia robusta), applyA11y
       • api() ................ wrapper de fetch (querystring + token + trata 401/429)
       • Galeria .............. carrossel de fotos do lead + arrastar-soltar
       • RENDER ............... renderFilters/Feed/Detail/Status — reconcile sem flicker
       • EVENTOS .............. 1 listener de click delegado + drag/drop + busca
       • load()/silentLoad() .. carga inicial + refresh silencioso a cada 10s
       • ANÁLISE ............. painel de funil + A/B (fetch próprio, refresh 20s)
     Acessibilidade: spans clicáveis viram role=button/tabindex via applyA11y();
     o keydown global converte Enter/Espaço em clique. Toast tem aria-live.
     ============================================================================ */
    const $ = id => document.getElementById(id);
    const TKEY = 'eterniza_admin_token';
    let token = sessionStorage.getItem(TKEY) || '';
    let ORDERS = [], FILTER = 'produzir', selId = null, editing = false, initialFilterSet = false, userCleared = false;
    let autoTimer = null, sig = '', selSig = '';
    let deferredPrompt = null;
    const isDesktop = () => window.matchMedia('(min-width:881px)').matches;

    // status -> rótulo + cor do chip
    const TAG = {
      briefing_recebido:{l:'Briefing',c:'#85b7eb,#185fa5,rgba(55,138,221,.14)'},
      checkout_iniciado:{l:'Checkout',c:'#facc15,#854f0b,rgba(234,179,8,.14)'},
      recuperacao_pix:{l:'Pix não pago',c:'#fb923c,#993c1d,rgba(249,115,22,.14)'},
      pago:{l:'Pago',c:'#22c55e,#0f6e2f,rgba(34,197,94,.14)'},
      fila_edicao:{l:'Fila de edição',c:'#2dd4bf,#0f6e56,rgba(20,184,166,.14)'},
      produzindo:{l:'Produzindo',c:'#a78bfa,#3c3489,rgba(139,92,246,.14)'},
      pronta:{l:'Pronta',c:'#85b7eb,#185fa5,rgba(55,138,221,.14)'},
      entregue:{l:'Entregue',c:'#86efac,#27500a,rgba(34,197,94,.18)'},
      erro:{l:'Erro',c:'#f87171,#791f1f,rgba(239,68,68,.16)'},
    };
    const FLOW = ['pago','fila_edicao','produzindo','pronta','entregue'];
    const FLOW_LBL = {pago:'Pago',fila_edicao:'Fila',produzindo:'Produzindo',pronta:'Pronta',entregue:'Entregue'};
    const PRODUZIR = ['pago','fila_edicao','produzindo','pronta'];
    const RECUPERAR = ['recuperacao_pix','checkout_iniciado','briefing_recebido'];
    const RECOVERY = [['contatado','Contatado'],['convertido','Convertido ✓'],['descartado','Descartado']];
    // tag de recuperação visível no card (nao_contatado / sem_resposta => sem tag)
    const RECO_TAG = { contatado:['Contatado','#7cc0ff','rgba(96,165,250,.13)'], convertido:['Convertido ✓','#86efac','rgba(34,197,94,.15)'], descartado:['Descartado','#fca5a5','rgba(248,113,113,.13)'] };
    function recoTag(o){ const t=RECO_TAG[o&&o.recovery_contact_status]; return t?`<span class="chip" style="color:${t[1]};background:${t[2]};border:1px solid ${t[1]}33">${esc(t[0])}</span>`:''; }
    const ATT = { folha:['🌿 Folha','#22c55e','rgba(34,197,94,.14)'], davi:['🔥 Davi','#f87171','rgba(248,113,113,.14)'] };
    function attTag(o){ const t=ATT[o&&o.attendant]; return t?`<span class="chip" style="color:${t[1]};background:${t[2]};border:1px solid ${t[1]}33">${t[0]}</span>`:`<span class="chip" style="color:#9ca3af;background:rgba(255,255,255,.05);border:1px solid #ffffff14">○ Livre</span>`; }
    function sourceTag(o){ const s=(o.typebot_payload||{}).source; if(s==='homenagem') return '<span class="chip" style="color:#c084fc;background:rgba(192,132,252,.12);border:1px solid #c084fc33">✨ Prévia</span>'; if(o.typebot_payload) return '<span class="chip" style="color:#67e8f9;background:rgba(103,232,249,.1);border:1px solid #67e8f933">🤖 Bot</span>'; return ''; }
    // ⚡ só enquanto a confirmação automática NÃO saiu; ✅ quando já foi enviada
    const confirmTag=o=>{ if(!o||!['pago','fila_edicao'].includes(o.status)) return ''; return o.wa_confirm_sent_at?'<span class="chip" style="background:rgba(34,197,94,.14);color:#86efac;border:1px solid rgba(34,197,94,.35)">✅ confirmado</span>':'<span class="chip" style="background:rgba(251,191,36,.14);color:#fcd34d;border:1px solid rgba(251,191,36,.35)">⚡ confirmar</span>'; };
    const ALL_STATUS = ['briefing_recebido','checkout_iniciado','recuperacao_pix','pago','fila_edicao','produzindo','pronta','entregue','erro'];
    const FILTERS = [
      {key:'recuperar',label:'Recuperar',test:o=>RECUPERAR.includes(o.status)},
      {key:'produzir',label:'Produzir',test:o=>PRODUZIR.includes(o.status)},
      {key:'entregues',label:'Entregues',test:o=>o.status==='entregue'},
      {key:'erro',label:'Erro',test:o=>o.status==='erro'},
      {key:'todos',label:'Todos',test:()=>true},
    ];

    const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const fmt = iso=>{try{return new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}catch(e){return ''}};
    const fmtFull = iso=>{try{return new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch(e){return '—'}};
    const money = v=>v==null?null:'R$ '+Number(v).toFixed(2).replace('.',',');
    const waLink=(phone,text)=>`https://wa.me/${(phone||'').replace(/\D/g,'')}?text=${encodeURIComponent(text)}`;
    // remove DDI 55 do número antes de exibir/copiar (wa.me precisa do 55; exibição não)
    const stripCC=p=>(p||'').replace(/\D/g,'').replace(/^55(\d{10,11})$/,'$1');
    const firstName = n => (n||'').trim().split(/\s+/)[0]||'';
    // 2º WhatsApp (número alternativo) — guardado em recovery_notes como "tel2:<norm>"
    const phone2 = o => { const m=String((o&&o.recovery_notes)||'').match(/tel2:(\d{12,13})/); return m?m[1]:''; };
    // IP/região de onde o lead acessou (capturado no cadastro, guardado em typebot_payload)
    function ipLine(o){ const tp=(o&&o.typebot_payload)||{}; const ip=tp._ip,geo=tp._geo,at=tp._ip_at; if(!ip&&!geo) return ''; return `<div class="mono" style="font-size:10.5px;color:var(--muted2);margin-top:4px" title="IP/região de onde o lead acessou">🌐 ${ip?esc(ip):'IP n/d'}${geo?' · '+esc(geo):''}${at?' · '+esc(fmt(at)):''}</div>`; }
    function chip(status){const t=TAG[status]||{l:status,c:'#9ca3af,#444,rgba(255,255,255,.06)'};const[fg,,bgc]=t.c.split(',');const bg=t.c.split(',').slice(2).join(',');return `<span class="chip" style="color:${fg};background:${bg};border:1px solid ${fg}33">${esc(t.l)}</span>`;}
    function toast(m,kind){const t=$('toast');t.textContent=m;t.className='show'+(kind?' '+kind:'');clearTimeout(toast._t);toast._t=setTimeout(()=>t.className='',2400)}

    // Cópia robusta — antes o código dava "Copiado ✓" mesmo quando a escrita falhava (permissão
    // negada / contexto sem HTTPS). Aqui só confirma quando REALMENTE copiou; com fallback legado.
    async function copyText(text,okMsg){
      text=text==null?'':String(text);
      try{
        if(navigator.clipboard&&window.isSecureContext){ await navigator.clipboard.writeText(text); }
        else{
          const ta=document.createElement('textarea');
          ta.value=text; ta.setAttribute('readonly',''); ta.style.cssText='position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(ta); ta.select();
          const ok=document.execCommand&&document.execCommand('copy'); ta.remove();
          if(!ok) throw new Error('execCommand_copy_failed');
        }
        toast(okMsg||'Copiado ✓','ok');
      }catch(e){ toast('Não consegui copiar — selecione e copie manualmente','err'); }
    }

    // ===== Acessibilidade: controles custom (spans clicáveis) operáveis por teclado =====
    // Filtros, pills e toggles são <span> com data-*; sem role/tabindex não recebem foco nem
    // respondem a Enter/Espaço. applyA11y() roda após cada render (idempotente); o keydown global
    // converte Enter/Espaço no controle focado em clique (o listener de click delegado trata o resto).
    const A11Y_SEL='[data-f],[data-rc],[data-att],[data-fpreset],[data-preset],[data-fatt],[data-sel]';
    function applyA11y(root){
      (root||document).querySelectorAll(A11Y_SEL).forEach(el=>{
        if(!el.hasAttribute('role')) el.setAttribute('role','button');
        if(!el.hasAttribute('tabindex')) el.setAttribute('tabindex','0');
      });
    }
    document.addEventListener('keydown',e=>{
      if(e.key!=='Enter'&&e.key!==' ')return;
      const el=document.activeElement;
      if(el&&el.matches&&el.matches(A11Y_SEL)){ e.preventDefault(); el.click(); }
    });

    // Rede de segurança: nada de erro silencioso — vai pro console (ajuda a depurar no celular).
    window.addEventListener('unhandledrejection',ev=>console.error('[hub] rejeição não tratada:',ev&&ev.reason));
    window.addEventListener('error',ev=>{ if(ev&&ev.error) console.error('[hub] erro não tratado:',ev.error); });

    // ===== filtro por data (fuso LOCAL do operador, ex.: BRT) — feed + análise =====
    const pad2=n=>String(n).padStart(2,'0');
    function ymdLocal(off){ const d=new Date(); if(off)d.setDate(d.getDate()+off); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
    function ymdToMid(s){ if(!s)return null; const p=String(s).split('-').map(Number); if(p.length!==3||!p[0])return null; return new Date(p[0],p[1]-1,p[2],0,0,0,0); }
    // "Até" é INCLUSIVO do dia inteiro: limite superior = meia-noite do dia SEGUINTE (exclusivo)
    function dateBounds(fromYMD,toYMD){ const a=ymdToMid(fromYMD); let b=ymdToMid(toYMD); if(b){b=new Date(b.getTime());b.setDate(b.getDate()+1);} return {fromTs:a?a.getTime():null,toTs:b?b.getTime():null,fromISO:a?a.toISOString():null,toISO:b?b.toISOString():null}; }
    const PRESETS={ tudo:()=>['',''], hoje:()=>[ymdLocal(0),ymdLocal(0)], ontem:()=>[ymdLocal(-1),ymdLocal(-1)], '7d':()=>[ymdLocal(-6),ymdLocal(0)], '30d':()=>[ymdLocal(-29),ymdLocal(0)] };
    function detectPreset(fromYMD,toYMD){ for(const k of ['tudo','hoje','ontem','7d','30d']){ const [a,b]=PRESETS[k](); if(a===(fromYMD||'')&&b===(toYMD||''))return k; } return null; }
    let FEED_FROM='', FEED_TO='';                       // feed: default Tudo (sem filtro)
    let ANA_FROM=ymdLocal(0), ANA_TO=ymdLocal(0);        // análise: default Hoje

    async function api(action,params,opts){
      opts=opts||{};
      const qs=new URLSearchParams({action,...(params||{}),_:Date.now()}).toString();
      const init={headers:{'x-admin-token':token},cache:'no-store'};
      if(opts.method)init.method=opts.method;
      if(opts.body){init.headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body)}
      const r=await fetch('/api/hub?'+qs,init);
      const d=await r.json().catch(()=>({}));
      if(r.status===429)throw{code:429,retryAfter:d.retryAfter||30};
      if(r.status===401)throw{code:401,remaining:d.remaining};
      if(!r.ok)throw{code:r.status,detail:d.detail||d.error};
      return d;
    }
    function handleErr(e,fb){if(e&&e.code===401){stopAuto();sessionStorage.removeItem(TKEY);token='';showLogin('Sessão expirada. Entre de novo.');return}toast((fb||'Erro')+(e&&e.detail?': '+e.detail:''),'err')}
    const showLogin=m=>{$('app').style.display='none';$('login').style.display='grid';if(m)$('loginErro').textContent=m};
    const showApp=()=>{$('login').style.display='none';$('app').style.display='flex'};

    // link do agente GPT (botão "Abrir agente GPT" na produção) — Lucas me passa a URL
    const GPT_AGENT_URL='https://chatgpt.com/g/g-6a373795b044819186491ae48945fbec-diretor-de-producao-eterniza';

    // ----- normalização (cobre os 2 formatos de "parente": "Meu Pai" e "seu pai") -----
    function relPhrase(rel){
      if(!rel) return '';
      const r=rel.trim().toLowerCase().replace(/^(minha|meu|sua|seu)\s+/,'');
      const map={'mãe':'da sua mãe','mae':'da sua mãe','pai':'do seu pai','companheiro(a)':'do seu companheiro(a)','companheiro':'do seu companheiro','companheira':'da sua companheira','filho(a)':'do seu filho(a)','filho':'do seu filho','filha':'da sua filha','irmão(ã)':'do seu irmão(ã)','irmão':'do seu irmão','irmao':'do seu irmão','irmã':'da sua irmã','avó':'da sua avó','avô':'do seu avô','ente querido':'do seu ente querido'};
      if(map[r]) return map[r];
      if(/pessoa especial|familiar|amigo/.test(r)) return '';
      return 'de '+rel.trim();
    }
    function memPhrase(mem){if(!mem)return '';let s=mem.replace(/[\u{1F000}-\u{1FAFF}☀-➿←-⇿⬀-⯿️‍]/gu,'').trim();s=s.replace(/\bme\b/gi,'te');return s?s.charAt(0).toLowerCase()+s.slice(1):''}
    function destPhrase(o){
      const rp=relPhrase(o.relationship), nome=o.recipient_name;
      if(nome && rp) return `${rp}, ${nome}`;
      if(nome) return `de ${nome}`;
      if(rp) return rp;
      return 'de alguém muito especial';
    }

    // ----- mensagens (template — IA depois; usam os dados reais do form) -----
    function confirmMsg(o){
      const ola=firstName(o.customer_name)?`Olá, ${firstName(o.customer_name)}!`:'Olá!';
      const hom=o.recipient_name?` de *${o.recipient_name}*`:'';
      return `${ola} 🕊️\n\nRecebi o pedido da homenagem${hom} com muito carinho. ❤️\n\nSeu pagamento foi confirmado e já estamos trabalhando com toda atenção. Em até 24h você recebe o vídeo, a música e a arte aqui no seu WhatsApp.\n\nQualquer dúvida, é só me chamar! 🙏\n— Equipe Eterniza`;
    }
    function deliverMsg(o){
      const ola=firstName(o.customer_name)?`Olá ${firstName(o.customer_name)}!`:'Olá!';
      return `${ola} 🕊️ A homenagem em vídeo ${destPhrase(o)} ficou pronta, feita com muito carinho.\n\nAqui está:\n${o.video_url||'[link do vídeo]'}`;
    }
    function recoveryMsg(o){
      const ola=firstName(o.customer_name)?`Olá ${firstName(o.customer_name)}! 💛`:'Oi! 💛';
      const mem=memPhrase(o.memory);
      const meio=mem?`pra eternizar ${mem} ${destPhrase(o)}`:`${destPhrase(o)}`;
      return `${ola} Aqui é da Eterniza.\n\nVi que você começou a homenagem em vídeo ${meio} — mas o pagamento ainda não foi concluído.\n\nPosso te ajudar a finalizar agora pra essa lembrança ganhar vida? 🕊️`;
    }
    async function downloadPhoto(url,name){
      try{const r=await fetch(url);const b=await r.blob();const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=(name?'homenagem-'+name.replace(/\s+/g,'-'):'foto')+'.jpg';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u);toast('Foto baixada ✓','ok')}
      catch(e){window.open(url,'_blank');toast('Abri a foto em nova aba (salve por aí)','ok')}
    }
    async function copyPhoto(url){
      try{
        let blob=await (await fetch(url)).blob();
        if(blob.type!=='image/png'){const img=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);blob=await new Promise(res=>c.toBlob(res,'image/png'))}
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        toast('Imagem copiada — cole no ChatGPT (Ctrl+V) ✓','ok');
      }catch(e){toast('Não deu p/ copiar; arraste ou baixe a foto','err')}
    }
    // textos pra copiar (formato WhatsApp do Lucas)
    function memClean(m){return (m||'').replace(/[\u{1F000}-\u{1FAFF}☀-➿←-⇿⬀-⯿️‍]/gu,'').replace(/\s+/g,' ').trim()}
    function briefingText(o){
      const obj=o.objetivo||(o.typebot_payload&&o.typebot_payload.objetivo);
      const L=[`parente: ${o.relationship||'—'}`,`nome: ${o.recipient_name||'—'}`,`memoria: ${memClean(o.memory)||'—'}`];
      if(obj) L.push(`Objetivo: ${obj}`);
      return L.join('\n');
    }
    function buyerText(o){
      const tel=stripCC(o.phone_normalized||o.customer_phone||'');
      return `Nome\n${o.customer_name||'—'}\n\nE-mail\n${o.customer_email||'—'}\n\nCelular\n${tel||'—'}`;
    }

    // ---- Galeria de fotos do lead (Feature B): carrossel + arrastar-soltar + capa + deletar ----
    // gallery = capa (photo_url) + extras do array `photos`, sem repetir. NADA se perde (array só cresce).
    function galleryList(o){
      const out=[],seen=new Set();
      for(const u of [o.photo_url,...(Array.isArray(o.photos)?o.photos:[])]){ if(u&&!seen.has(u)){seen.add(u);out.push(u)} }
      return out;
    }
    const GAL_IDX={}; // o.id -> índice atual no carrossel (sobrevive ao re-render do detalhe)
    function galIndex(o){const l=galleryList(o);let i=GAL_IDX[o.id]||0;if(i>=l.length)i=l.length?l.length-1:0;if(i<0)i=0;GAL_IDX[o.id]=i;return i}
    function galPhoto(o){const l=galleryList(o);return l[galIndex(o)]||''}
    function photoGallery(o,maxw){
      const list=galleryList(o),i=galIndex(o),cur=list[i]||'',id=o.id,n=list.length;
      const isCover=!!cur&&cur===o.photo_url;
      const img=cur
        ?`<img class="photo" data-photo="${esc(cur)}" draggable="true" src="${esc(cur)}" alt="foto" title="Clique p/ ampliar · arraste pro GPT">`
        :`<div class="photo ph">🖼️</div>`;
      const nav=n>1?`<button class="galbtn gprev" data-galnav="${id}|-1" title="Anterior">‹</button><button class="galbtn gnext" data-galnav="${id}|1" title="Próxima">›</button><span class="galcount">${i+1}/${n}</span>`:'';
      const cover=isCover&&n>1?`<span class="galcover">★ capa</span>`:'';
      return `<div class="gallery" style="max-width:${maxw||150}px">
        <div class="galframe" data-galdrop="${id}">${img}${nav}${cover}<div class="galdrophint">📥 solte a(s) foto(s)</div></div>
        <div class="galtools">
          <button class="btn xs" data-galadd="${id}" title="Adicionar foto">＋ foto</button>
          ${cur?`<button class="btn xs" data-cpphoto="${esc(cur)}" title="Copiar imagem">📋</button>`:''}
          ${cur&&!isCover?`<button class="btn xs" data-galmain="${id}|${esc(cur)}" title="Tornar esta a capa">★ capa</button>`:''}
          ${n>1?`<button class="btn xs danger" data-galdel="${id}|${esc(cur)}" title="Remover esta foto">🗑</button>`:''}
        </div>
        <input type="file" accept="image/*" data-galfile="${id}" multiple hidden>
      </div>`;
    }

    // ================= RENDER =================
    // contagem por aba num único passe (evita 5 .filter() alocando arrays a cada render)
    function counts(){const c={};FILTERS.forEach(f=>c[f.key]=0);for(const o of ORDERS)for(const f of FILTERS)if(f.test(o))c[f.key]++;return c}
    function renderFilters(){
      const c=counts();
      $('filters').innerHTML=FILTERS.map(f=>
        `<div class="f ${f.key} ${f.key===FILTER?'on':''}" data-f="${f.key}"><span class="lbl">${f.label}</span><span class="c">${c[f.key]}</span></div>`
      ).join('');
      renderAttFilter();
    }
    function renderAttFilter(){
      const box=$('attFilters'); if(!box) return;
      const cnts={todos:ORDERS.length,folha:ORDERS.filter(o=>o.attendant==='folha').length,davi:ORDERS.filter(o=>o.attendant==='davi').length,none:ORDERS.filter(o=>!o.attendant).length};
      const items=[['todos','Todos'],['folha','🌿 Folha'],['davi','🔥 Davi'],['none','○ Livre']];
      box.innerHTML=items.map(([k,l])=>`<span class="p ${ATT_FILTER===k?'on':''}" data-fatt="${k}">${l} <span style="font-size:10px;opacity:.65">${cnts[k]}</span></span>`).join('');
      applyA11y();
    }
    let SEARCH='', ATT_FILTER='todos';
    // casa por NÚMERO (dígitos, em phone_normalized/customer_phone) OU por NOME (comprador/homenageado)
    function matchesSearch(o,q){
      q=(q||'').trim(); if(!q) return true;
      const d=q.replace(/\D/g,'');
      const phone=((o.phone_normalized||'')+(o.customer_phone||'')).replace(/\D/g,'');
      if(d && phone.includes(d)) return true;
      return (((o.customer_name||'')+' '+(o.recipient_name||'')).toLowerCase().includes(q.toLowerCase()));
    }
    // com busca ativa, procura em TODOS os status (acha o lead em qualquer aba); sem busca, usa a aba atual
    function filtered(){
      const q=(SEARCH||'').trim();
      if(q) return ORDERS.filter(o=>matchesSearch(o,q)); // busca acha em qualquer status/data
      const f=FILTERS.find(x=>x.key===FILTER)||FILTERS[0];
      let list=ORDERS.filter(f.test);
      const {fromTs,toTs}=dateBounds(FEED_FROM,FEED_TO); // filtro por data (opcional)
      if(fromTs!=null||toTs!=null) list=list.filter(o=>{const t=new Date(o.created_at||0).getTime();return (fromTs==null||t>=fromTs)&&(toTs==null||t<toTs);});
      if(ATT_FILTER==='none') list=list.filter(o=>!o.attendant);
      else if(ATT_FILTER!=='todos') list=list.filter(o=>o.attendant===ATT_FILTER);
      return list;
    }
    // conteúdo INTERNO do card (sem o wrapper) — usado no reconcile
    function cardInner(o){
      const hasBuyer=!!o.customer_name;
      const titulo=hasBuyer
        ? `👤 ${esc(o.customer_name)} <span class="tagrole">(Comprador)</span>`
        : `🕊️ Homenagem para ${esc(o.recipient_name||'(sem nome)')}`;
      const sub=hasBuyer
        ? `🕊️ Homenagem para <b>${esc(o.recipient_name||'—')}</b>${o.relationship?' · '+esc(o.relationship):''}`
        : `${o.relationship?esc(o.relationship)+' · ':''}<span style="color:#e7a17a">comprador no pagamento</span>`;
      return `<div class="fc-top"><span class="nm">${titulo}</span><span class="dt mono">${esc(fmt(o.created_at))}</span></div>
          <span class="for">${sub}</span>
          <div class="tags">${chip(o.status)}${confirmTag(o)}${recoTag(o)}${attTag(o)}${sourceTag(o)}</div>`;
    }
    const cardSig=o=>JSON.stringify([o.customer_name,o.recipient_name,o.relationship,o.status,o.created_at,o.recovery_contact_status,o.attendant,o.wa_confirm_sent_at]);
    // RECONCILE: cria/atualiza/move só o que mudou. Cards iguais ficam intactos
    // => não re-anima (acaba a "piscada") e não joga o scroll pro topo.
    function renderFeed(){
      const list=filtered(); const host=$('feedList');
      { const fc=$('feedCount'); if(fc) fc.textContent=list.length; }
      if(!list.length){ host.innerHTML='<div class="hint" style="margin:14px">'+(SEARCH.trim()?('Nenhum lead encontrado para “'+esc(SEARCH.trim())+'”.'):'Nenhum pedido nesta aba.')+'</div>'; return; }
      const have={}; host.querySelectorAll('.feed-card[data-sel]').forEach(el=>{ have[el.dataset.sel]=el; });
      [...host.children].forEach(el=>{ if(!el.classList.contains('feed-card')) el.remove(); }); // tira o "Carregando…"
      const seen=new Set(); let prev=null;
      for(const o of list){
        const id=String(o.id); seen.add(id); const sig=cardSig(o); let el=have[id];
        const attCls=o.attendant?'att-'+o.attendant:'att-none';
        if(!el){
          el=document.createElement('div'); el.dataset.sel=id; el.dataset.sig=sig;
          el.className='feed-card '+attCls+(o.id===selId?' sel':''); el.innerHTML=cardInner(o);
        } else {
          if(el.dataset.sig!==sig){ el.innerHTML=cardInner(o); el.dataset.sig=sig; }
          const cls='feed-card '+attCls+(o.id===selId?' sel':''); if(el.className!==cls) el.className=cls;
        }
        const ref=prev?prev.nextSibling:host.firstChild;
        if(el!==ref) host.insertBefore(el,ref);
        prev=el;
      }
      host.querySelectorAll('.feed-card[data-sel]').forEach(el=>{ if(!seen.has(el.dataset.sel)) el.remove(); });
      applyA11y(host);
    }
    function kv(k,v,copy){const empty=v==null||v==='';return `<div><div class="k">${k}</div><div class="v ${empty?'empty':''} ${(!empty&&copy)?'cp':''}" ${(!empty&&copy)?`data-copy="${esc(v)}"`:''}>${empty?'—':esc(v)}</div></div>`}

    function renderDetail(){
      const inner=$('detail').firstElementChild;
      const o=ORDERS.find(x=>x.id===selId);
      if(!o){inner.innerHTML='<div class="emptystate"><div class="big">🕊️</div><div>Selecione um pedido para ver os detalhes.</div></div>';return}
      const phone=o.phone_normalized||o.customer_phone;
      const isRec=RECUPERAR.includes(o.status);
      const isProd=PRODUZIR.includes(o.status)||o.status==='entregue';

      let html=`<button class="back" data-back>← Pedidos</button>
        <div class="d-head">
          <div style="min-width:0">
            <div class="d-buyer">${o.customer_name?'👤 '+esc(o.customer_name)+' <span class="tagrole">(Comprador)</span>':'<span style="color:#888">👤 comprador ainda não identificado</span>'}</div>
            <div class="htags" style="margin-top:7px">${chip(o.status)}<span class="mono" style="font-size:11px;color:var(--muted2)">${esc(fmt(o.created_at))}</span></div>
            ${ipLine(o)}
          </div>
          <div class="acts">
            <button class="btn ghost sm" data-edit="${o.id}">✎ Editar</button>
            <button class="btn danger sm" data-del="${o.id}">🗑 Excluir</button>
          </div>
        </div>
        <div class="pills" style="margin-bottom:4px;margin-top:2px">${[['','○ Livre'],['folha','🌿 Folha'],['davi','🔥 Davi']].map(([k,l])=>`<span class="p ${(o.attendant||'')===k?'on':''}" data-att="${o.id}|${k}">${l}</span>`).join('')}</div>`;

      if(editing){ html+=editForm(o); inner.innerHTML=html; applyA11y(inner); return; }

      if(['pago','fila_edicao'].includes(o.status)&&phone){
        if(o.wa_confirm_sent_at) html+=`<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.28);border-radius:12px;padding:11px 15px;margin:10px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="font-size:13px;font-weight:700;color:#86efac">✅ Confirmação automática enviada</div><div style="font-size:12px;color:#a3a3a3">· ${esc(fmt(o.wa_confirm_sent_at))}</div></div>`;
        else html+=`<div style="background:rgba(251,191,36,.09);border:1px solid rgba(251,191,36,.3);border-radius:12px;padding:13px 15px;margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div style="font-size:13px;font-weight:700;color:#fcd34d">⚡ Confirmação automática ainda não saiu</div><div style="font-size:12px;color:#a3a3a3;margin-top:2px">Rede de segurança — envie manual se precisar</div></div><a class="wpp" href="${waLink(phone,confirmMsg(o))}" target="_blank" rel="noopener" style="flex-shrink:0">📤 Confirmar manual</a></div>`;
      }
      if(o.status==='pronta'&&phone&&o.video_url) html+=`<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.28);border-radius:12px;padding:13px 15px;margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div style="font-size:13px;font-weight:700;color:#86efac">🎬 Homenagem pronta — entregar agora</div><div style="font-size:12px;color:#a3a3a3;margin-top:2px">O vídeo está pronto e aguardando entrega</div></div><a class="wpp" href="${waLink(phone,deliverMsg(o))}" target="_blank" rel="noopener" style="flex-shrink:0">🎬 Entregar agora</a></div>`;

      // dados da homenagem (comum aos dois formatos) — todos os campos coletados no fluxo
      const obj=o.objetivo||(o.typebot_payload&&o.typebot_payload.objetivo);
      const homage=`<div class="ov" style="margin-bottom:3px">🕊️ Homenageado(a) — homenagem para</div><div class="recip">${esc(o.recipient_name||'—')}</div>
        <div class="recip-rel">${o.relationship?esc(o.relationship):'<span style="color:#555">relação não informada</span>'}</div>
        ${o.memory?`<div style="margin-top:9px"><div class="ov" style="margin-bottom:4px">Memória mais marcante</div><div class="memory">${esc(o.memory)}</div></div>`:''}
        ${obj?`<div style="margin-top:9px"><div class="ov" style="margin-bottom:3px">Objetivo da homenagem</div><div class="objv">${esc(obj)}</div></div>`:''}`;
      // contato/pagamento — só campos presentes (lead não tem e-mail/valor; pago mostra o valor real, já com order bump)
      const cf=[];
      if(phone) cf.push(`<div><div class="k">WhatsApp</div><div class="v cp mono" data-copy="${esc(stripCC(o.customer_phone||phone))}">${esc(stripCC(o.customer_phone||phone))}</div></div>`);
      { const p2=phone2(o); if(p2){ const m2=['pago','fila_edicao'].includes(o.status)?confirmMsg(o):(o.status==='pronta'||o.status==='entregue')?deliverMsg(o):RECUPERAR.includes(o.status)?recoveryMsg(o):''; cf.push(`<div><div class="k">2º WhatsApp <span style="color:#fcd34d" title="número alternativo — um dos dois pode estar errado">⚠</span></div><div class="v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="cp mono" data-copy="${esc(stripCC(p2))}">${esc(stripCC(p2))}</span><a class="wpp" style="padding:2px 10px;font-size:12px" href="${waLink(p2,m2)}" target="_blank" rel="noopener">📲 Chamar</a></div></div>`); } }
      if(o.customer_email) cf.push(`<div><div class="k">E-mail</div><div class="v cp" data-copy="${esc(o.customer_email)}">${esc(o.customer_email)}</div></div>`);
      if(o.valor!=null) cf.push(`<div><div class="k">Valor pago</div><div class="v">${esc(money(o.valor))}</div></div>`);
      if(o.pix_generated_at) cf.push(`<div><div class="k">Pix gerado</div><div class="v mono">${esc(fmt(o.pix_generated_at))}</div></div>`);
      if(o.delivered_at) cf.push(`<div><div class="k">Entregue em</div><div class="v mono">${esc(fmt(o.delivered_at))}</div></div>`);
      const contato=cf.length?`<div class="kvc">${cf.join('')}</div>`:'';

      if(isRec){
        // ===== FORMATO RECUPERAÇÃO (não pago) — foto aparece aqui (uma vez) =====
        const cur=galPhoto(o);
        const rc=o.recovery_contact_status||'nao_contatado';
        html+=`<div class="section"><div class="sh"><span class="st">Dados coletados</span></div><div class="sb">
            <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
              <div style="flex:0 0 auto">${photoGallery(o,130)}</div>
              <div style="min-width:200px;flex:1">${homage}</div>
            </div>
            <div class="msgrow" style="margin-top:10px">
              <button class="btn sm primary" data-copybrief="${o.id}">📋 Copiar tudo pro GPT</button>
              ${cur?`<button class="btn sm" data-cpphoto="${esc(cur)}">🖼️ Copiar imagem</button>`:''}
              <a class="btn sm ghost" href="${GPT_AGENT_URL}" target="_blank" rel="noopener">🤖 Agente GPT ↗</a>
            </div>
            ${contato}
          </div></div>
          <div class="section" style="margin-top:12px"><div class="sh"><span class="st">Recuperação de Pix</span></div><div class="sb stack">
            <div class="alert warn"><span>⚠️</span><span>Deu o número e começou a homenagem, mas <b>não finalizou o pagamento</b>. Chame no WhatsApp pra ajudar a concluir.</span></div>
            <div class="msgbox">
              <div class="ov" style="margin-bottom:6px">Mensagem de recuperação</div>
              <textarea class="msgIn" data-msg="rec-${o.id}" rows="4">${esc(recoveryMsg(o))}</textarea>
              <div class="msgrow">
                ${phone?`<a class="wpp" data-walink="rec-${o.id}" href="${waLink(phone,recoveryMsg(o))}" target="_blank" rel="noopener">📲 Chamar no WhatsApp</a>`:'<span class="hint">Sem telefone válido.</span>'}
                <button class="btn sm" data-copymsg="rec-${o.id}">Copiar</button>
              </div>
            </div>
            <div><div class="ov" style="margin-bottom:7px">Situação do contato</div>
              <div class="pills">${RECOVERY.map(([k,l])=>`<span class="p ${rc===k?'on':''}" data-rc="${o.id}|${k}">${l}</span>`).join('')}</div>
            </div>
          </div></div>`;
      } else {
        // ===== FORMATO PRODUÇÃO / ENTREGA (pago) — foto aparece na produção (uma vez) =====
        const idx=FLOW.indexOf(o.status);
        const flow=FLOW.map((s,i)=>`<button class="${s===o.status?'cur':(i<idx&&idx>=0?'done':'')}" data-status="${o.id}|${s}">${FLOW_LBL[s]}</button>`).join('');
        const cur=galPhoto(o), rn=esc(o.recipient_name||''), memorial='Em memória de '+(o.recipient_name||''), ready=!!o.video_url;
        html+=`<div class="section"><div class="sh"><span class="st">Dados da homenagem</span></div><div class="sb">
            ${homage}
            ${contato}
          </div></div>
          <div class="section" style="margin-top:14px"><div class="sh"><span class="st">Produção do vídeo</span></div><div class="sb stack">
            <div class="alert" style="background:var(--accent-soft);border:1px solid var(--accent-border);color:var(--accent-lt)"><span>🎬</span><span>Copie/arraste a foto pro <b>Diretor de Produção Eterniza</b> (agente GPT). Quando o vídeo ficar pronto, cole o link e vá pra entrega.</span></div>
            <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
              ${photoGallery(o,170)}
              <div style="flex:1;min-width:210px" class="stack">
                ${cur?`<div class="msgrow" style="margin-top:0"><button class="btn sm primary" data-cpphoto="${esc(cur)}">📋 Copiar imagem</button><button class="btn sm" data-dlphoto="${esc(cur)}|${rn}">⬇ Baixar</button><a class="btn sm ghost" href="${esc(cur)}" target="_blank" rel="noopener">Abrir ↗</a><a class="btn sm" href="${GPT_AGENT_URL}" target="_blank" rel="noopener">🤖 Agente GPT ↗</a></div>`:'<div class="hint">⚠️ Sem foto — arraste uma pro quadro ao lado ou use ＋ foto.</div>'}
                <div><div class="ov" style="margin-bottom:4px">Texto do vídeo</div><div class="msgrow" style="margin-top:0"><input readonly value="${esc(memorial)}" style="flex:1;min-width:150px"><button class="btn sm" data-copytext="${esc(memorial)}">Copiar</button></div></div>
              </div>
            </div>
            <div><div class="ov" style="margin-bottom:7px">Etapa do pedido</div><div class="flow">${flow}</div></div>
            <div><div class="ov" style="margin-bottom:6px">Link do vídeo final</div>
              <div class="msgrow" style="margin-top:0">
                <input class="vidIn" data-vid="${o.id}" placeholder="cole o link do vídeo pronto" value="${esc(o.video_url||'')}" style="flex:1;min-width:200px">
                <button class="btn sm" data-savevid="${o.id}">Salvar</button>
              </div>
            </div>
          </div></div>
          <div class="section" style="margin-top:14px"><div class="sh"><span class="st">Entrega</span></div><div class="sb stack">
            <div><div class="ov" style="margin-bottom:6px">Copiar dados (formato WhatsApp)</div>
              <div class="msgrow" style="margin-top:0">
                <button class="btn sm" data-copybrief="${o.id}">📋 Briefing (parente/nome/memória)</button>
                <button class="btn sm" data-copybuyer="${o.id}">📋 Dados do comprador</button>
              </div>
            </div>
            <div class="msgbox">
              <div class="ov" style="margin-bottom:6px">Mensagem de entrega</div>
              <textarea class="msgIn" data-msg="del-${o.id}" rows="5">${esc(deliverMsg(o))}</textarea>
              <div class="msgrow">
                ${phone?`<a class="wpp" data-walink="del-${o.id}" href="${waLink(phone,deliverMsg(o))}" target="_blank" rel="noopener">📲 Entregar no WhatsApp</a>`:'<span class="hint">Sem telefone válido.</span>'}
                <button class="btn sm" data-copymsg="del-${o.id}">Copiar</button>
                ${o.status!=='entregue'?`<button class="btn primary sm" data-status="${o.id}|entregue">Marcar entregue</button>`:''}
              </div>
              ${!ready?'<div class="hint" style="margin-top:10px">Cole o link do vídeo na produção pra ele entrar na mensagem de entrega automaticamente.</div>':''}
            </div>
          </div></div>`;
      }

      inner.innerHTML=html; applyA11y(inner);
    }

    function editForm(o){
      const F=(k,v)=>esc(v==null?'':v);
      const opts=ALL_STATUS.map(s=>`<option value="${s}" ${o.status===s?'selected':''}>${esc((TAG[s]||{l:s}).l)}</option>`).join('');
      return `<div class="section"><div class="sh"><span class="st">Editar pedido · admin</span><span class="ov">corrija e salve</span></div><div class="sb">
        <div class="editgrid">
          <label><span class="ov">Comprador</span><input id="e_cn" value="${F('',o.customer_name)}"></label>
          <label><span class="ov">WhatsApp</span><input id="e_ph" value="${F('',o.customer_phone||o.phone_normalized)}"></label>
          <label><span class="ov">2º WhatsApp (alt)</span><input id="e_p2" value="${F('',phone2(o))}" placeholder="número alternativo"></label>
          <label><span class="ov">E-mail</span><input id="e_em" value="${F('',o.customer_email)}"></label>
          <label><span class="ov">Valor (R$)</span><input id="e_vl" inputmode="decimal" value="${o.valor==null?'':o.valor}"></label>
          <label><span class="ov">Homenageado(a)</span><input id="e_rn" value="${F('',o.recipient_name)}"></label>
          <label><span class="ov">Relação</span><input id="e_rel" value="${F('',o.relationship)}"></label>
          <label><span class="ov">Status</span><select id="e_st">${opts}</select></label>
          <label><span class="ov">Foto (URL)</span><input id="e_ph2" value="${F('',o.photo_url)}"></label>
          <label class="full"><span class="ov">Memória / história</span><textarea id="e_mem" rows="3">${F('',o.memory)}</textarea></label>
          <label class="full"><span class="ov">Vídeo final (URL)</span><input id="e_vid" value="${F('',o.video_url)}"></label>
        </div>
        <div class="msgrow">
          <button class="btn primary sm" data-savedit="${o.id}">💾 Salvar alterações</button>
          <button class="btn ghost sm" data-canceledit>Cancelar</button>
        </div>
      </div></div>`;
    }

    function renderStatus(){
      const c=counts();
      $('status').innerHTML=
        `<span class="m" data-f="todos"><b>${c.todos}</b> pedidos</span><span class="sep">·</span>`+
        `<span class="m" data-f="recuperar"><b>${c.recuperar}</b> recuperar</span><span class="sep">·</span>`+
        `<span class="m" data-f="produzir"><b>${c.produzir}</b> produzir</span><span class="sep">·</span>`+
        `<span class="m" data-f="entregues"><b>${c.entregues}</b> entregues</span>`+
        `<span class="lv"><span class="live-dot"></span>ao vivo</span>`;
      applyA11y($('status'));
    }

    function renderAll(){renderFilters();renderFeed();renderStatus();renderDetail();selSig=JSON.stringify(ORDERS.find(o=>o.id===selId)||null)}

    function selectOrder(id){
      selId=id; editing=false; userCleared=false;
      document.body.classList.add('viewing');
      renderFeed(); renderDetail();
      selSig=JSON.stringify(ORDERS.find(o=>o.id===id)||null);
      $('detail').scrollTop=0;
    }
    // clicar de novo no lead já selecionado (desktop) → limpa o painel e fica esperando nova seleção
    function deselectOrder(){
      selId=null; editing=false; userCleared=true;
      document.body.classList.remove('viewing');
      renderFeed(); renderDetail();
      selSig=JSON.stringify(ORDERS.find(o=>o.id===selId)||null);
      $('detail').scrollTop=0;
    }
    function ensureSelection(){
      const list=filtered();
      if(selId&&!list.some(o=>o.id===selId)&&!ORDERS.some(o=>o.id===selId))selId=null;
      if(isDesktop()&&!selId&&!userCleared&&list.length){selId=list[0].id;selSig=JSON.stringify(list[0])}
    }

    function defaultFilter(){
      for(const k of ['produzir','recuperar','entregues','erro']){
        const f=FILTERS.find(x=>x.key===k);
        if(f && ORDERS.filter(f.test).length) return k;
      }
      return 'todos';
    }
    // ordena por mais RECENTE primeiro (created_at). NÃO usar updated_at: o backfill do
    // objetivo bumpou o updated_at dos leads antigos, jogando-os acima dos recentes.
    function sortByActivity(arr){ return arr.slice().sort((a,b)=> new Date(b.created_at||0) - new Date(a.created_at||0)); }
    async function load(){
      userCleared=false;
      try{
        const {orders}=await api('list');
        const raw=orders||[]; sig=JSON.stringify(raw); ORDERS=sortByActivity(raw);
        if(!initialFilterSet){ FILTER=defaultFilter(); initialFilterSet=true; }
        ensureSelection(); renderAll();
      }catch(e){handleErr(e,'Falha ao carregar');if(e&&e.code!==401)$('feedList').innerHTML='<div class="hint" style="margin:14px">Erro ao carregar. <small>'+(e.detail||'')+'</small></div>'}
    }

    // refresh silencioso a cada 10s — preserva seleção, não atrapalha digitação
    async function silentLoad(){
      if(editing||document.hidden||$('lb').style.display==='grid'||$('analytics').style.display==='flex')return;
      const a=document.activeElement; if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT'))return;
      try{
        const {orders}=await api('list');
        const ns=JSON.stringify(orders||[]);
        if(ns===sig){setLiveErr(false);return}
        sig=ns; ORDERS=sortByActivity(orders||[]); ensureSelection();
        renderFilters();renderFeed();renderStatus();
        const cur=JSON.stringify(ORDERS.find(o=>o.id===selId)||null);
        if(cur!==selSig){selSig=cur;renderDetail()}
        setLiveErr(false);
      }catch(e){if(e&&e.code===401)handleErr(e);else setLiveErr(true)}
    }
    function setLiveErr(v){document.querySelectorAll('.live-dot').forEach(d=>d.style.background=v?'#f87171':'')}
    function startAuto(){stopAuto();autoTimer=setInterval(silentLoad,10000)}
    function stopAuto(){clearInterval(autoTimer);autoTimer=null}

    // ================= EVENTOS =================
    document.addEventListener('click',async ev=>{
      const t=ev.target;
      const filt=t.closest('[data-f]'); if(filt){FILTER=filt.dataset.f;SEARCH='';const _fs=$('feedSearch');if(_fs){_fs.value='';_fs.parentElement.classList.remove('has')}userCleared=false;selId=isDesktop()?selId:null;if(!isDesktop())document.body.classList.remove('viewing');ensureSelection();renderAll();return}
      const card=t.closest('[data-sel]'); if(card){const cid=card.dataset.sel;if(isDesktop()&&cid===selId){deselectOrder();}else{selectOrder(cid);}return}
      if(t.closest('[data-back]')){document.body.classList.remove('viewing');return}
      const ph=t.closest('[data-photo]'); if(ph){$('lb').querySelector('img').src=ph.dataset.photo;$('lb').style.display='grid';return}
      const cp=t.closest('[data-copy]'); if(cp){copyText(cp.dataset.copy,'Copiado: '+cp.dataset.copy);return}

      const stt=t.closest('[data-status]'); if(stt){const[id,s]=stt.dataset.status.split('|');try{await api('update',{id,status:s});toast('Status: '+(FLOW_LBL[s]||s),'ok');await load()}catch(e){handleErr(e,'Falha')}return}
      const rc=t.closest('[data-rc]'); if(rc){const[id,k]=rc.dataset.rc.split('|');try{await api('recovery',{id,recovery_contact_status:k});if(k==='convertido')await api('update',{id,status:'fila_edicao'});toast(k==='convertido'?'Convertido → movido pra Produzir ✓':'Atualizado','ok');await load()}catch(e){handleErr(e,'Falha')}return}
      const at=t.closest('[data-att]'); if(at){const[id,k]=at.dataset.att.split('|');try{await api('assign',{id,attendant:k});const o=ORDERS.find(x=>x.id===id);if(o)o.attendant=k||null;toast(k?('Atribuído a '+(k==='folha'?'🌿 Folha':'🔥 Davi')):'Liberado ○','ok');await load()}catch(e){handleErr(e,'Falha')}return}
      const fatt=t.closest('[data-fatt]'); if(fatt){ATT_FILTER=fatt.dataset.fatt;renderFeed();renderAttFilter();return}
      const sv=t.closest('[data-savevid]'); if(sv){const id=sv.dataset.savevid;const inp=document.querySelector(`input[data-vid="${id}"]`);const vurl=inp?inp.value.trim():'';try{await api('set_video',{id,video_url:vurl});toast('Vídeo salvo ✓','ok');const o=ORDERS.find(x=>x.id===id);if(o)o.video_url=vurl;selSig='';renderDetail()}catch(e){handleErr(e,'Falha')}return}
      const cm=t.closest('[data-copymsg]'); if(cm){const ta=document.querySelector(`textarea[data-msg="${cm.dataset.copymsg}"]`);if(ta){copyText(ta.value,'Mensagem copiada')}return}
      const ct=t.closest('[data-copytext]'); if(ct){copyText(ct.dataset.copytext,'Copiado ✓');return}
      const dpf=t.closest('[data-dlphoto]'); if(dpf){const[u,n]=dpf.dataset.dlphoto.split('|');downloadPhoto(u,n);return}
      const cpf=t.closest('[data-cpphoto]'); if(cpf){copyPhoto(cpf.dataset.cpphoto);return}
      const cbr=t.closest('[data-copybrief]'); if(cbr){const o=ORDERS.find(x=>x.id===cbr.dataset.copybrief);if(o){copyText(briefingText(o),'Briefing copiado ✓')}return}
      const cbu=t.closest('[data-copybuyer]'); if(cbu){const o=ORDERS.find(x=>x.id===cbu.dataset.copybuyer);if(o){copyText(buyerText(o),'Dados do comprador copiados ✓')}return}

      // ---- Galeria de fotos (Feature B) ----
      const gnav=t.closest('[data-galnav]'); if(gnav){const p=gnav.dataset.galnav.split('|'),id=p[0],dir=+p[1];const o=ORDERS.find(x=>x.id===id);if(o){const n=galleryList(o).length||1;GAL_IDX[id]=((GAL_IDX[id]||0)+dir+n)%n;selSig='';renderDetail()}return}
      const gadd=t.closest('[data-galadd]'); if(gadd){const f=document.querySelector(`input[data-galfile="${gadd.dataset.galadd}"]`);if(f)f.click();return}
      const gmain=t.closest('[data-galmain]'); if(gmain){const s=gmain.dataset.galmain,k=s.indexOf('|'),id=s.slice(0,k),url=s.slice(k+1);try{await api('set_main_photo',{id,url});const o=ORDERS.find(x=>x.id===id);if(o)o.photo_url=url;toast('Capa atualizada ✓','ok');selSig='';renderDetail()}catch(e){handleErr(e,'Falha')}return}
      const gdel=t.closest('[data-galdel]'); if(gdel){const s=gdel.dataset.galdel,k=s.indexOf('|'),id=s.slice(0,k),url=s.slice(k+1);if(!url)return;if(!confirm('Remover esta foto da galeria? (as outras permanecem)'))return;try{const d=await api('del_photo',{id,url});const o=ORDERS.find(x=>x.id===id);if(o){o.photos=Array.isArray(d.photos)?d.photos:[];if('photo_url'in d)o.photo_url=d.photo_url}GAL_IDX[id]=0;toast('Foto removida','ok');selSig='';renderDetail()}catch(e){handleErr(e,'Falha')}return}

      const ed=t.closest('[data-edit]'); if(ed){editing=true;renderDetail();return}
      if(t.closest('[data-canceledit]')){editing=false;renderDetail();return}
      const sd=t.closest('[data-savedit]'); if(sd){await saveEdit(sd.dataset.savedit);return}
      const dl=t.closest('[data-del]'); if(dl){if(!confirm('Excluir este pedido definitivamente?'))return;try{await api('delete',{id:dl.dataset.del});toast('Excluído','ok');selId=null;editing=false;if(!isDesktop())document.body.classList.remove('viewing');await load()}catch(e){handleErr(e,'Falha')}return}
    });

    // ---- Galeria (Feature B): arrastar-soltar + seletor de arquivo + redução no browser ----
    async function uploadGalleryFile(id,file){
      if(!file||!/^image\//.test(file.type||'')){toast('Arraste um arquivo de imagem','err');return}
      try{
        const dataUrl=await shrinkImage(file,1280,.85);
        const d=await api('add_photo',{id},{method:'POST',body:{image:dataUrl}});
        const o=ORDERS.find(x=>x.id===id);
        if(o){o.photos=Array.isArray(d.photos)?d.photos:(o.photos||[]);if(d.photo_url)o.photo_url=d.photo_url;GAL_IDX[id]=Math.max(0,galleryList(o).length-1)}
        selSig='';renderDetail();toast('Foto adicionada ✓','ok');
      }catch(e){handleErr(e,'Falha ao enviar foto')}
    }
    // reduz no navegador (lado máx N) -> dataURL jpeg leve (upload rápido e abaixo do limite do serverless)
    function shrinkImage(file,max,q){return new Promise((res,rej)=>{const img=new Image(),u=URL.createObjectURL(file);img.onload=()=>{let w=img.naturalWidth,h=img.naturalHeight;if(w>max||h>max){const s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s)}const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',q))};img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error('img_load'))};img.src=u})}
    document.addEventListener('dragover',ev=>{const z=ev.target.closest&&ev.target.closest('[data-galdrop]');if(z&&ev.dataTransfer&&[...(ev.dataTransfer.types||[])].includes('Files')){ev.preventDefault();z.classList.add('drop')}});
    document.addEventListener('dragleave',ev=>{const z=ev.target.closest&&ev.target.closest('[data-galdrop]');if(z&&!z.contains(ev.relatedTarget))z.classList.remove('drop')});
    document.addEventListener('drop',async ev=>{const z=ev.target.closest&&ev.target.closest('[data-galdrop]');if(!z)return;ev.preventDefault();z.classList.remove('drop');const id=z.dataset.galdrop,files=[...((ev.dataTransfer&&ev.dataTransfer.files)||[])].filter(f=>/^image\//.test(f.type||''));for(const f of files)await uploadGalleryFile(id,f)});
    document.addEventListener('change',async ev=>{const fi=ev.target;if(fi.tagName==='INPUT'&&fi.type==='file'&&fi.dataset.galfile){const id=fi.dataset.galfile,files=[...(fi.files||[])];fi.value='';for(const f of files)await uploadGalleryFile(id,f)}});

    // mantém wa.me sincronizado se editar a mensagem
    document.addEventListener('input',ev=>{
      const ta=ev.target; if(ta.tagName!=='TEXTAREA'||!ta.dataset.msg)return;
      const link=document.querySelector(`[data-walink="${ta.dataset.msg}"]`);
      if(link){const u=new URL(link.href);u.searchParams.set('text',ta.value);link.href=u.toString()}
    });

    async function saveEdit(id){
      const g=i=>{const el=$(i);return el?el.value:undefined};
      const body={
        customer_name:g('e_cn'),customer_phone:g('e_ph'),customer_email:g('e_em'),
        valor:g('e_vl'),recipient_name:g('e_rn'),relationship:g('e_rel'),
        status:g('e_st'),photo_url:g('e_ph2'),memory:g('e_mem'),video_url:g('e_vid'),phone2:g('e_p2'),
      };
      try{await api('edit',{id},{method:'POST',body});toast('Pedido atualizado ✓','ok');editing=false;await load()}
      catch(e){handleErr(e,'Falha ao salvar')}
    }

    $('lb').addEventListener('click',()=>$('lb').style.display='none');
    $('liveBtn')?.addEventListener('click',()=>{sig='';selSig='';load()});
    // busca de lead (número ou nome) — filtra o feed ao vivo
    (function(){
      const inp=$('feedSearch'); if(!inp) return;
      const wrap=inp.parentElement, clr=$('feedSearchClear');
      const apply=()=>{ SEARCH=inp.value; wrap.classList.toggle('has',!!inp.value.trim()); renderFeed(); };
      inp.addEventListener('input',apply);
      inp.addEventListener('keydown',e=>{ if(e.key==='Escape'){ inp.value=''; apply(); inp.blur(); } });
      if(clr) clr.addEventListener('click',()=>{ inp.value=''; apply(); inp.focus(); });
    })();
    // filtro por data do FEED (Tudo/Hoje/Ontem + range De→Até) — client-side, default Tudo
    (function(){
      const box=$('feedDates'); if(!box) return;
      const fromI=$('feedFrom'), toI=$('feedTo');
      const hi=()=>{ const k=detectPreset(FEED_FROM,FEED_TO); box.querySelectorAll('.p').forEach(p=>p.classList.toggle('on',p.dataset.fpreset===k)); };
      const apply=()=>{ FEED_FROM=fromI.value||''; FEED_TO=toI.value||''; hi(); renderFeed(); };
      box.querySelectorAll('.p').forEach(p=>p.addEventListener('click',()=>{ const [a,b]=PRESETS[p.dataset.fpreset](); fromI.value=a; toI.value=b; apply(); }));
      fromI.addEventListener('change',apply); toI.addEventListener('change',apply);
      hi();
    })();
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token&&$('app').style.display!=='none')silentLoad()});
    $('btnLogout').addEventListener('click',()=>{stopAuto();sessionStorage.removeItem(TKEY);token='';selId=null;document.body.classList.remove('viewing');showLogin()});

    // ===== painel de análise · dashboard horizontal (auto-refresh próprio) =====
    let anaBuilt=false, anaLastUpdate=0, anaSinceISO=null, anaTimer=null, anaTick=null;
    let FUNNEL_MODE='bot', lastAnaData=null, lastQuizAbData=null, lastCheckoutAbData=null;
    function setFunnelMode(mode){
      FUNNEL_MODE=mode; anaBuilt=false;
      document.querySelectorAll('.ana-tab').forEach(b=>b.classList.toggle('on',b.id===(mode==='bot'?'tabBot':'tabH')));
      if(lastAnaData) paintFunnel(lastAnaData);
    }
    const SHORT={pagina_venda:'Página',cta_clicou:'Clicou CTA',g1_abertura:'Abertura',g2_porquem:'Por quem',g3_nome:'Nome',g4_memoria:'Memória',g5_desejo:'Desejo',g6_video:'Vídeo',g7_foto:'Foto',g8_whatsapp:'WhatsApp',h_hero:'Pág. H',h_quiz:'CTA hero',h_nome:'Q1 quem',h_memoria:'Q2 nome',h_whatsapp:'WhatsApp',h_foto:'Foto',h_previa:'Prévia',h_checkout:'Finalizar'};

    function buildFunnelSkeleton(funnel){
      const cols=funnel.map(s=>`<div class="fcol" data-step="${esc(s.step)}" title="${esc(s.label)}">
          <div class="fval"><span class="fcount">0</span><span class="fpct">0%</span></div>
          <div class="ftrack"><div class="fbar"></div></div>
          <div class="flabel">${esc(SHORT[s.step]||s.label)}</div>
          <div class="fkeep"></div>
        </div>`).join('');
      $('funnelView').innerHTML=`
        <div class="kpis">
          <div class="kpi gold"><span class="n" id="kOferta">–</span><span class="l">Chegaram na oferta</span></div>
          <div class="kpi"><span class="n" id="kRecup">–</span><span class="l">Pix em recuperação</span></div>
          <div class="kpi"><span class="n" id="kPago">–</span><span class="l">Pagaram</span></div>
          <div class="kpi accent"><span class="n" id="kConv">–</span><span class="l">Conversão oferta→pago</span></div>
        </div>
        <div class="fchart-wrap">
          <div class="fchart-h">
            <span class="fchart-t">Funil do fluxo · sessões rastreadas</span>
            <span class="fchart-legend"><span><i class="dot-g"></i>etapa</span><span><i class="dot-r"></i>maior queda</span></span>
          </div>
          <div class="fchart" id="fchart">${cols}</div>
          <div class="fchart-empty" id="fEmpty" hidden>Sem sessões rastreadas neste período ainda — os blocos vão preenchendo conforme o tráfego entrar.</div>
        </div>
        <div class="ana-foot">
          <span class="ana-base">Cards de cima = pedidos no período · gráfico = sessões rastreadas desde a página de venda (bases diferentes).</span>
          <span class="ana-meta"><span class="live-dot ana-livedot"></span>atualizado <b id="anaAgo">agora</b> · metrificando desde <b id="anaSince">—</b></span>
        </div>
        <div class="abwrap" id="quizAbWrap" hidden>
          <h4>🧪 A/B Quiz · Typebot × /homenagem <span class="ab-since" id="quizAbSince"></span></h4>
          <div class="abgrid">
            <div class="abcol" id="quizTypebot">
              <div class="gw">📱 Typebot <small>quiz atual</small></div>
              <div class="abrow"><span>Mandados</span><b id="qtAssigned">–</b></div>
              <div class="abrow"><span>Iniciou quiz</span><b id="qtStarted">–</b></div>
              <div class="abrow"><span>Passou Q1</span><b id="qtQ1">–</b></div>
              <div class="abrow"><span>WhatsApp</span><b id="qtWhatsapp">–</b></div>
              <div class="abrow"><span>Foto</span><b id="qtPhoto">–</b></div>
              <div class="abrow"><span>Checkout</span><b id="qtCheckout">–</b></div>
              <div class="abrow"><span>Vendas</span><b id="qtPaid">–</b></div>
              <div class="abrow"><span>Conversão</span><b id="qtConv">–</b></div>
              <div class="abrow hl"><span>R$ / visitante</span><b id="qtRpv">–</b></div>
            </div>
            <div class="abcol" id="quizHomenagem">
              <div class="gw">🖼️ /homenagem <small>prévia inline</small></div>
              <div class="abrow"><span>Mandados</span><b id="qhAssigned">–</b></div>
              <div class="abrow"><span>Iniciou quiz</span><b id="qhStarted">–</b></div>
              <div class="abrow"><span>Passou Q1</span><b id="qhQ1">–</b></div>
              <div class="abrow"><span>WhatsApp</span><b id="qhWhatsapp">–</b></div>
              <div class="abrow"><span>Foto</span><b id="qhPhoto">–</b></div>
              <div class="abrow"><span>Prévia</span><b id="qhPreview">–</b></div>
              <div class="abrow"><span>Checkout</span><b id="qhCheckout">–</b></div>
              <div class="abrow"><span>Vendas</span><b id="qhPaid">–</b></div>
              <div class="abrow"><span>Conversão</span><b id="qhConv">–</b></div>
              <div class="abrow hl"><span>R$ / visitante</span><b id="qhRpv">–</b></div>
            </div>
          </div>
          <div class="ab-note" id="quizAbNote"></div>
        </div>
        <div class="abwrap" id="abWrap" hidden>
          <h4>🧪 A/B Checkout · Cakto × Yampi <span class="ab-since" id="abSince"></span></h4>
          <div class="abgrid">
            <div class="abcol" id="abCakto">
              <div class="gw">🟦 Cakto</div>
              <div class="abrow"><span>Mandados</span><b id="cAssigned">–</b></div>
              <div class="abrow"><span>Vendas</span><b id="cPaid">–</b></div>
              <div class="abrow"><span>Recuperação (Pix)</span><b id="cRec">–</b></div>
              <div class="abrow"><span>Conversão</span><b id="cConv">–</b></div>
              <div class="abrow"><span>Ticket médio</span><b id="cTicket">–</b></div>
              <div class="abrow hl"><span>R$ / visitante</span><b id="cRpv">–</b></div>
            </div>
            <div class="abcol" id="abYampi">
              <div class="gw">🟩 Yampi <small>(MP + bumps)</small></div>
              <div class="abrow"><span>Mandados</span><b id="yAssigned">–</b></div>
              <div class="abrow"><span>Vendas</span><b id="yPaid">–</b></div>
              <div class="abrow"><span>Recuperação (Pix)</span><b id="yRec">–</b></div>
              <div class="abrow"><span>Conversão</span><b id="yConv">–</b></div>
              <div class="abrow"><span>Ticket médio</span><b id="yTicket">–</b></div>
              <div class="abrow hl"><span>R$ / visitante</span><b id="yRpv">–</b></div>
            </div>
          </div>
          <div class="ab-note" id="abNote"></div>
        </div>`;
      anaBuilt=true;
      if(lastQuizAbData) paintQuizAB(lastQuizAbData);
      if(lastCheckoutAbData) paintAB(lastCheckoutAbData);
    }

    function paintFunnel(d){
      lastAnaData=d;
      const f=(d&&(FUNNEL_MODE==='homenagem'?d.funnelH:d.funnel))||[];
      if(!anaBuilt){ if(!f.length){$('funnelView').innerHTML='<div class="ana-loading">Sem dados ainda para este funil.</div>';return} buildFunnelSkeleton(f); }
      const chart=$('fchart'); if(!chart)return;
      const top=Math.max(1,(f[0]&&f[0].count)||0);
      let maxDropIdx=-1,maxDrop=0; // maior QUEDA EM VOLUME (onde se perde mais gente), não % relativo
      for(let i=1;i<f.length;i++){const drop=(f[i-1].count||0)-(f[i].count||0);if(drop>maxDrop){maxDrop=drop;maxDropIdx=i}}
      const total=f.reduce((a,s)=>a+(s.count||0),0);
      const fEmpty=$('fEmpty'); if(fEmpty)fEmpty.hidden=total>0;
      chart.style.opacity=total>0?'1':'.22';
      const heights=[];
      f.forEach((s,i)=>{
        const col=chart.querySelector(`.fcol[data-step="${s.step}"]`); if(!col)return;
        const cnt=s.count||0;
        const pctTop=Math.max(0,Math.min(100,Math.round((cnt/top)*100)));
        const prev=i>0?(f[i-1].count||0):null;
        const keep=(prev!=null&&prev>0)?Math.round((cnt/prev)*100):null;
        const isDrop=(i===maxDropIdx&&maxDrop>0);
        col.querySelector('.fcount').textContent=cnt;
        col.querySelector('.fpct').textContent=pctTop+'%';
        const k=col.querySelector('.fkeep'); k.textContent=keep!=null?(keep+'% do anterior'+(isDrop?' 👈':'')):''; k.className='fkeep'+(isDrop?' warn':'');
        const bar=col.querySelector('.fbar'); bar.classList.toggle('drop',isDrop); bar.classList.toggle('has',cnt>0);
        heights.push([bar,pctTop]);
      });
      requestAnimationFrame(()=>heights.forEach(([bar,h])=>{bar.style.height=h+'%'}));
      const sl=(d&&d.sales)||{}, conv=(sl.oferta>0)?Math.round((sl.pago/sl.oferta)*100):0;
      if($('kOferta'))$('kOferta').textContent=sl.oferta||0;
      if($('kRecup'))$('kRecup').textContent=sl.recuperacao||0;
      if($('kPago'))$('kPago').textContent=sl.pago||0;
      if($('kConv'))$('kConv').textContent=conv+'%';
      anaSinceISO=(d&&d.trackingSince)||null;
      if($('anaSince'))$('anaSince').textContent=anaSinceISO?fmtFull(anaSinceISO):'aguardando 1º evento';
      anaLastUpdate=Date.now(); updateAnaAgo();
    }

    const AB_MIN_N=10; // amostra mínima por lado antes de cravar vencedor
    function paintAB(d){
      lastCheckoutAbData=d;
      const ab=d&&d.ab, w=$('abWrap'); if(!w)return;
      if(!ab){ w.hidden=true; return; }
      w.hidden=false;
      const set=(id,v)=>{const e=$(id); if(e)e.textContent=v;};
      const money=v=>v==null?'–':('R$ '+Number(v).toFixed(2).replace('.',','));
      const pct=v=>v==null?'–':(v+'%');
      const c=ab.cakto||{}, y=ab.yampi||{};
      set('cAssigned',c.assigned||0); set('cPaid',c.paid||0); set('cRec',c.recuperacao||0); set('cConv',pct(c.conversion)); set('cTicket',money(c.ticket)); set('cRpv',money(c.rev_per_visitor));
      set('yAssigned',y.assigned||0); set('yPaid',y.paid||0); set('yRec',y.recuperacao||0); set('yConv',pct(y.conversion)); set('yTicket',money(y.ticket)); set('yRpv',money(y.rev_per_visitor));
      $('abCakto').classList.remove('win'); $('abYampi').classList.remove('win');
      w.querySelectorAll('.win-tag').forEach(t=>t.remove());
      const cv=c.rev_per_visitor||0, yv=y.rev_per_visitor||0;
      let note;
      if((c.assigned||0)<AB_MIN_N||(y.assigned||0)<AB_MIN_N){
        note='⏳ Amostra ainda pequena (ideal ~'+AB_MIN_N+'+ visitantes por lado). Deixe rodar antes de decidir.';
      } else if(Math.abs(cv-yv)<0.01){
        note='Empate técnico em R$/visitante. Continue coletando.';
      } else {
        const winId=yv>cv?'abYampi':'abCakto', winName=yv>cv?'Yampi':'Cakto';
        $(winId).classList.add('win');
        const tag=document.createElement('span'); tag.className='win-tag'; tag.textContent='🏆 na frente'; $(winId).appendChild(tag);
        const diff=Math.abs(yv-cv)/Math.max(0.01,Math.min(cv,yv))*100;
        note='🏆 <b>'+winName+'</b> está faturando ~'+diff.toFixed(0)+'% mais por visitante. Com volume suficiente, pode virar 100% pra ele.';
      }
      const n=$('abNote'); if(n)n.innerHTML=note;
      const s=$('abSince'); if(s)s.textContent='· desde 24/06 (início do teste)';
    }

    function paintQuizAB(d){
      lastQuizAbData=d;
      const ab=d&&d.quizAb, w=$('quizAbWrap'); if(!w)return;
      if(!ab){ w.hidden=true; return; }
      w.hidden=false;
      const set=(id,v)=>{const e=$(id); if(e)e.textContent=v;};
      const money=v=>v==null?'–':('R$ '+Number(v).toFixed(2).replace('.',','));
      const pct=v=>v==null?'–':(v+'%');
      const t=ab.typebot||{}, h=ab.homenagem||{};
      set('qtAssigned',t.assigned||0); set('qtStarted',(t.started||0)+' · '+pct(t.started_rate)); set('qtQ1',t.answered1||0); set('qtWhatsapp',(t.whatsapp||0)+' · '+pct(t.whatsapp_rate)); set('qtPhoto',(t.photo||0)+' · '+pct(t.photo_rate)); set('qtCheckout',(t.checkout||0)+' · '+pct(t.checkout_rate)); set('qtPaid',t.paid||0); set('qtConv',pct(t.conversion)); set('qtRpv',money(t.rev_per_visitor));
      set('qhAssigned',h.assigned||0); set('qhStarted',(h.started||0)+' · '+pct(h.started_rate)); set('qhQ1',h.answered1||0); set('qhWhatsapp',(h.whatsapp||0)+' · '+pct(h.whatsapp_rate)); set('qhPhoto',(h.photo||0)+' · '+pct(h.photo_rate)); set('qhPreview',h.preview==null?'–':h.preview); set('qhCheckout',(h.checkout||0)+' · '+pct(h.checkout_rate)); set('qhPaid',h.paid||0); set('qhConv',pct(h.conversion)); set('qhRpv',money(h.rev_per_visitor));
      $('quizTypebot').classList.remove('win'); $('quizHomenagem').classList.remove('win');
      w.querySelectorAll('.win-tag').forEach(x=>x.remove());
      const tv=t.rev_per_visitor||0, hv=h.rev_per_visitor||0;
      let note;
      if((t.assigned||0)<AB_MIN_N||(h.assigned||0)<AB_MIN_N){
        note='⏳ Amostra ainda pequena (ideal ~'+AB_MIN_N+'+ cliques por lado). O split já está ativo; deixe rodar antes de decidir.';
      } else if(Math.abs(tv-hv)<0.01){
        note='Empate técnico em R$/visitante. Olhe também WhatsApp, foto e checkout antes de mexer no tráfego.';
      } else {
        const winId=hv>tv?'quizHomenagem':'quizTypebot', winName=hv>tv?'/homenagem':'Typebot';
        $(winId).classList.add('win');
        const tag=document.createElement('span'); tag.className='win-tag'; tag.textContent='🏆 na frente'; $(winId).appendChild(tag);
        const diff=Math.abs(hv-tv)/Math.max(0.01,Math.min(tv,hv))*100;
        note='🏆 <b>'+winName+'</b> está gerando ~'+diff.toFixed(0)+'% mais R$/visitante neste recorte.';
      }
      const n=$('quizAbNote'); if(n)n.innerHTML=note;
      const s=$('quizAbSince'); if(s)s.textContent='· CTA da landing dividido 50/50';
    }

    function updateAnaAgo(){
      const el=$('anaAgo'); if(!el||!anaLastUpdate)return;
      const s=Math.round((Date.now()-anaLastUpdate)/1000);
      el.textContent = s<5?'agora':s<60?('há '+s+'s'):s<3600?('há '+Math.floor(s/60)+'min'):('às '+new Date(anaLastUpdate).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}));
    }
    function setAnaLive(err){const d=document.querySelector('.ana-livedot'); if(d)d.style.background=err?'var(--danger)':'';}

    // monta os params da análise a partir do range escolhido (from/to ISO); vazio = Tudo
    function anaParams(){ const {fromISO,toISO}=dateBounds(ANA_FROM,ANA_TO); if(!fromISO&&!toISO) return {period:'tudo'}; const p={}; if(fromISO)p.from=fromISO; if(toISO)p.to=toISO; return p; }
    // A/B só existe a partir do deploy do teste; nunca contar antes (senão vendas antigas inflam a Cakto)
    const AB_START='2026-06-24T17:55:00.000Z';
    function abParams(){ const p=anaParams(); const out={}; if(p.to)out.to=p.to; out.from=(p.from&&p.from>AB_START)?p.from:AB_START; return out; }
    // reflete ANA_FROM/ANA_TO nos inputs + destaca o preset correspondente
    function syncAnaControls(){ const F=$('anaFrom'),T=$('anaTo'); if(F)F.value=ANA_FROM; if(T)T.value=ANA_TO; const k=detectPreset(ANA_FROM,ANA_TO); document.querySelectorAll('#analytics .ana-periods .p').forEach(p=>p.classList.toggle('on',p.dataset.preset===k)); }
    async function refreshAnalytics(silent){
      if(silent&&document.hidden)return;
      try{
        const d=await api('analytics',anaParams()); paintFunnel(d); setAnaLive(false);
        try{ const q=await api('quiz_ab',anaParams()); paintQuizAB(q); }catch(_e){/* A/B quiz é complementar; não quebra a análise */}
        try{ const a=await api('ab',abParams()); paintAB(a); }catch(_e){/* A/B é complementar; não quebra a análise */}
      }
      catch(e){
        if(e&&e.code===401){stopAnaAuto();handleErr(e);return}
        if(!anaBuilt)$('funnelView').innerHTML='<div class="ana-loading">Erro ao carregar a análise.'+(e&&e.detail?' '+esc(e.detail):'')+'</div>';
        setAnaLive(true);
      }
    }
    async function loadAnalytics(){ if(!anaBuilt)$('funnelView').innerHTML='<div class="ana-loading">Carregando análise…</div>'; await refreshAnalytics(false); }
    function startAnaAuto(){ stopAnaAuto(); anaTimer=setInterval(()=>refreshAnalytics(true),20000); anaTick=setInterval(updateAnaAgo,1000); }
    function stopAnaAuto(){ clearInterval(anaTimer);clearInterval(anaTick);anaTimer=anaTick=null; }
    function openAnalytics(){ $('analytics').style.display='flex'; syncAnaControls(); loadAnalytics(); startAnaAuto(); }
    function closeAnalytics(){ $('analytics').style.display='none'; stopAnaAuto(); }

    $('btnAnalytics').addEventListener('click',openAnalytics);
    $('anaClose').addEventListener('click',closeAnalytics);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('analytics').style.display==='flex')closeAnalytics()});
    document.querySelectorAll('#analytics .ana-periods .p').forEach(b=>b.addEventListener('click',()=>{
      const [a,c]=PRESETS[b.dataset.preset](); ANA_FROM=a; ANA_TO=c; syncAnaControls(); refreshAnalytics(false);
    }));
    $('anaFrom').addEventListener('change',e=>{ ANA_FROM=e.target.value||''; syncAnaControls(); refreshAnalytics(false); });
    $('anaTo').addEventListener('change',e=>{ ANA_TO=e.target.value||''; syncAnaControls(); refreshAnalytics(false); });
    let lockTimer=null;
    function lockLogin(secs){
      const btn=$('loginForm').querySelector('button'), inp=$('senha');
      clearInterval(lockTimer); secs=Math.max(1,Math.ceil(secs||30));
      const tick=()=>{
        if(secs<=0){clearInterval(lockTimer);btn.disabled=false;inp.disabled=false;$('loginErro').textContent='';return}
        btn.disabled=true;inp.disabled=true;$('loginErro').textContent=`🔒 Muitas tentativas. Aguarde ${secs}s…`;secs--;
      };
      tick();lockTimer=setInterval(tick,1000);
    }
    $('loginForm').addEventListener('submit',async e=>{
      e.preventDefault();$('loginErro').textContent='';
      const v=$('senha').value.trim();if(!v){$('loginErro').textContent='Digite a senha.';return}
      token=v;
      try{await api('list');sessionStorage.setItem(TKEY,token);$('senha').value='';showApp();await load();startAuto()}
      catch(e){
        token='';
        if(e&&e.code===429){lockLogin(e.retryAfter)}
        else if(e&&e.code===401){$('loginErro').textContent='Senha incorreta.'+(e.remaining>0?` (${e.remaining} ${e.remaining===1?'tentativa':'tentativas'} restante${e.remaining===1?'':'s'})`:'')}
        else{$('loginErro').textContent='Erro ao conectar.'}
      }
    });

    // PWA: instalar
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('btnInstall').style.display='inline-flex'});
    $('btnInstall').addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('btnInstall').style.display='none'});
    window.addEventListener('appinstalled',()=>{$('btnInstall').style.display='none';toast('App instalado ✓','ok')});
    if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/hub/sw.js',{scope:'/hub/'}).catch(()=>{}))}

    applyA11y(); // tag inicial dos controles estáticos (presets de data, períodos)
    if(token){showApp();load();startAuto()}else{showLogin()}
