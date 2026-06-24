<!-- ============================================================================
  ETERNIZA · "MP Skin" para o checkout Yampi
  ----------------------------------------------------------------------------
  ONDE COLAR: Yampi -> Configurações -> Checkout -> Scripts (campo de código /
  "Scripts personalizados"). Cole este bloco INTEIRO (já vem com <style> e
  <script>). Não precisa mexer em mais nada.

  O QUE FAZ: deixa o checkout com cara de Mercado Pago (gateway real do Eterniza)
  pra ganhar confiança e reduzir a fricção no Pix — o problema de "chega no preço
  e não paga". Aplica nos 2 passos do checkout de uma vez (CSS é global).

  PASSO OBRIGATÓRIO ANTES DE USAR:
    1) Suba a logo OFICIAL do Mercado Pago num lugar estável (a própria Yampi em
       Arquivos, ou Imgur/seu storage) e cole a URL em MP_LOGO_URL abaixo.
       Enquanto estiver vazio, aparece o wordmark "Mercado Pago" em texto (não
       quebra nada — só fica menos bonito).

  ATENÇÃO (honesto): o passo 2 do checkout (onde aparecem os métodos de pagamento
  e o Pix) só renderiza depois de preencher os dados, então o destaque do botão/
  card do Pix é feito por um MutationObserver com seletor tolerante. Pode pedir 1
  ajuste fino quando você ver ao vivo — me manda print do passo 2 que eu calibro
  os seletores de PIX_* exatos.
============================================================================ -->

<style id="mp-skin-style">
  /* ---- Paleta oficial Mercado Pago ------------------------------------- */
  body.mercadopago {
    --mp-blue: #009ee3;        /* azul primário MP */
    --mp-blue-dark: #007eb5;   /* hover */
    --mp-blue-soft: #e5f6fd;   /* fundo suave / destaques */
    --mp-yellow: #ffe600;      /* amarelo MP (usar com parcimônia) */
    --mp-ink: #2d3277;         /* azul-tinta MP p/ títulos */
    --mp-text: #333333;
    --mp-line: #e6e6e6;
    background: #ededed;        /* fundo cinza-claro típico do MP */
  }

  /* ---- Faixa superior "Pagamento seguro · Mercado Pago" ---------------- */
  #mp-trust-bar {
    width: 100%;
    background: #fff;
    border-bottom: 1px solid var(--mp-line);
    box-shadow: 0 1px 3px rgba(0,0,0,.04);
  }
  #mp-trust-bar .mp-bar-inner {
    max-width: 1100px; margin: 0 auto; padding: 10px 18px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #mp-trust-bar .mp-logo { display: flex; align-items: center; gap: 8px; }
  #mp-trust-bar .mp-logo img { height: 26px; width: auto; display: block; }
  #mp-trust-bar .mp-logo .mp-wordmark {
    font-weight: 800; font-size: 17px; color: var(--mp-blue); letter-spacing: -.3px;
  }
  #mp-trust-bar .mp-secure {
    display: flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 600; color: #4b5563; white-space: nowrap;
  }
  #mp-trust-bar .mp-secure svg { width: 15px; height: 15px; fill: #16a34a; flex: none; }
  @media (max-width: 560px) {
    #mp-trust-bar .mp-secure span { display: none; }   /* no celular só o cadeado */
  }

  /* ---- Botões primários -> azul MP ------------------------------------- */
  body.mercadopago .btn-primary,
  body.mercadopago .btn-send,
  body.mercadopago button[type="submit"].btn-block {
    background: var(--mp-blue) !important;
    border-color: var(--mp-blue) !important;
    color: #fff !important;
    font-weight: 700 !important;
    border-radius: 6px !important;
    box-shadow: 0 2px 8px rgba(0,158,227,.25) !important;
    transition: background .15s ease, box-shadow .15s ease !important;
  }
  body.mercadopago .btn-primary:hover,
  body.mercadopago .btn-send:hover,
  body.mercadopago button[type="submit"].btn-block:hover {
    background: var(--mp-blue-dark) !important;
    border-color: var(--mp-blue-dark) !important;
    box-shadow: 0 4px 14px rgba(0,158,227,.35) !important;
  }
  /* Links e botões terciários no tom MP */
  body.mercadopago a,
  body.mercadopago .btn-tertiary { color: var(--mp-blue); }

  /* ---- Campos de formulário: foco azul MP ------------------------------ */
  body.mercadopago .holder-input.floating-input-label.focus,
  body.mercadopago .input:focus,
  body.mercadopago input:focus,
  body.mercadopago select:focus {
    border-color: var(--mp-blue) !important;
    box-shadow: 0 0 0 3px var(--mp-blue-soft) !important;
  }
  /* Títulos das etapas em azul-tinta MP */
  body.mercadopago .box-title .title { color: var(--mp-ink); }

  /* ---- Cartão de conteúdo mais "MP" (branco, cantos suaves) ------------ */
  body.mercadopago .col-checkout,
  body.mercadopago .box-title.--with-preview,
  body.mercadopago .holder-container-resume {
    border-radius: 8px;
  }

  /* ---- Destaque do PIX (passo 2) — aplicado via observer --------------- */
  body.mercadopago .mp-pix-highlight {
    outline: 2px solid var(--mp-blue) !important;
    background: var(--mp-blue-soft) !important;
    border-radius: 8px !important;
    position: relative;
  }
  body.mercadopago .mp-pix-badge {
    display: inline-block; margin-left: 8px; padding: 2px 8px;
    background: var(--mp-blue); color: #fff; font-size: 11px; font-weight: 700;
    border-radius: 999px; vertical-align: middle; letter-spacing: .2px;
  }

  /* ---- Rodapé de selos de confiança ------------------------------------ */
  #mp-trust-footer {
    max-width: 1100px; margin: 18px auto 28px; padding: 16px 18px;
    border-top: 1px solid var(--mp-line);
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 18px 26px; text-align: center;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #mp-trust-footer .mp-seal {
    display: flex; align-items: center; gap: 7px;
    font-size: 12.5px; font-weight: 600; color: #5b6470;
  }
  #mp-trust-footer .mp-seal svg { width: 16px; height: 16px; flex: none; }
  #mp-trust-footer .mp-foot-note {
    width: 100%; text-align: center; font-size: 12px; color: #8a93a0; margin-top: 4px;
  }
</style>

<script id="mp-skin-script">
(function () {
  "use strict";

  /* ====== CONFIG — preencha a logo do MP aqui ============================ */
  var MP_LOGO_URL = ""; // <<< COLE a URL da logo oficial do Mercado Pago. Vazio = wordmark em texto.
  /* ======================================================================= */

  // Só roda no checkout com gateway Mercado Pago (segurança extra).
  function isMP() {
    return document.body && document.body.classList.contains("mercadopago");
  }

  var LOCK_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5a4.5 4.5 0 0 0-4.5 4.5V9H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1.5V6A4.5 4.5 0 0 0 12 1.5Zm2.5 7.5h-5V6a2.5 2.5 0 0 1 5 0v3Z"/></svg>';
  var SHIELD_SVG =
    '<svg viewBox="0 0 24 24" fill="#16a34a" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.2-3-3 1.4-1.4 1.6 1.6 4-4 1.4 1.4-5.4 5.4Z"/></svg>';

  // 1) FAIXA SUPERIOR — logo MP + "Pagamento seguro"
  function injectTrustBar() {
    if (document.getElementById("mp-trust-bar")) return;
    var logoHtml = MP_LOGO_URL
      ? '<img src="' + MP_LOGO_URL + '" alt="Mercado Pago">'
      : '<span class="mp-wordmark">Mercado Pago</span>';
    var bar = document.createElement("div");
    bar.id = "mp-trust-bar";
    bar.innerHTML =
      '<div class="mp-bar-inner">' +
        '<div class="mp-logo">' + logoHtml + '</div>' +
        '<div class="mp-secure">' + LOCK_SVG + '<span>Pagamento 100% seguro · Mercado Pago</span></div>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // 2) RODAPÉ — selos de confiança
  function injectTrustFooter() {
    if (document.getElementById("mp-trust-footer")) return;
    var seals = [
      [SHIELD_SVG, "Ambiente 100% seguro"],
      [LOCK_SVG.replace(/<svg /, '<svg fill="#009ee3" '), "Seus dados protegidos"],
      [SHIELD_SVG, "Garantia de 7 dias"]
    ];
    var foot = document.createElement("div");
    foot.id = "mp-trust-footer";
    foot.innerHTML =
      seals.map(function (s) {
        return '<div class="mp-seal">' + s[0] + "<span>" + s[1] + "</span></div>";
      }).join("") +
      '<div class="mp-foot-note">Pagamento processado com segurança pelo Mercado Pago · Eterniza</div>';
    var host = document.querySelector(".inner-body") || document.body;
    host.appendChild(foot);
  }

  // 3) DESTAQUE DO PIX (passo 2) — seletor tolerante.
  //    Procura um rótulo/opção cujo texto seja "Pix" e destaca o container clicável.
  function highlightPix() {
    try {
      var nodes = document.querySelectorAll(
        'label, .option, [data-payment], .payment-method, .holder-payment, li, button'
      );
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.__mpPixDone) continue;
        var txt = (el.textContent || "").trim().toLowerCase();
        // casa "pix" curtinho (rótulo do método), evita textos longos
        if (txt === "pix" || (/(^|\s)pix(\s|$)/.test(txt) && txt.length <= 24)) {
          var box = el.closest(".option, .payment-method, .holder-payment, label, li") || el;
          box.classList.add("mp-pix-highlight");
          if (!box.querySelector(".mp-pix-badge")) {
            var badge = document.createElement("span");
            badge.className = "mp-pix-badge";
            badge.textContent = "aprovação na hora";
            (el.tagName === "LABEL" ? el : box).appendChild(badge);
          }
          el.__mpPixDone = true;
        }
      }
    } catch (e) { /* silencioso — nunca quebrar o checkout */ }
  }

  function run() {
    if (!isMP()) return;
    try { injectTrustBar(); } catch (e) {}
    try { injectTrustFooter(); } catch (e) {}
    highlightPix();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  // Reaplica quando o passo 2 (pagamento/Pix) renderiza dinamicamente.
  try {
    var obs = new MutationObserver(function () {
      if (!isMP()) return;
      highlightPix();
      if (!document.getElementById("mp-trust-footer")) { try { injectTrustFooter(); } catch (e) {} }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* navegador sem MutationObserver: ok, fica no estado inicial */ }
})();
</script>
