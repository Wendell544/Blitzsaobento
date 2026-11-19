/* Imagens: compressão WebP extrema, upload para Edge Function e geração de <img>. */
const IMG = (() => {
  const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
  const MB = 1024 * 1024;
  const UPLOAD_URL = `${SB_URL}/functions/v1/upload-image`;

  const URLS = new Map();
  const LIVE = new Set();

  const dec = (f) =>
    'createImageBitmap' in window
      ? createImageBitmap(f)
      : new Promise((ok, no) => {
          const i = new Image(),
            u = URL.createObjectURL(f);
          i.onload = () => { URL.revokeObjectURL(u); ok(i); };
          i.onerror = () => no(new Error('x'));
          i.src = u;
        });

  const cv = (s, max, type, q) => {
    const k = Math.min(1, max / Math.max(s.width, s.height)),
      c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(s.width * k));
    c.height = Math.max(1, Math.round(s.height * k));
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(s, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, type, q));
  };

  const enc = async (s, max, q = 0.8) => {
    let b = await cv(s, max, 'image/webp', q);
    if (!b || b.type !== 'image/webp') b = await cv(s, max, 'image/jpeg', q);
    return b;
  };

  const optimize = async (s) => {
    let max = 1200;
    let q = 0.82;
    let b = await enc(s, max, q);
    if (b && b.size > 200 * 1024) { max = 800; q = 0.7; b = await enc(s, max, q); }
    return b;
  };

  async function one(f) {
    const mb = DB.set.mb || 5;
    if (f.size > mb * MB) throw new Error(`${f.name}: passa de ${mb} MB.`);
    if (!TYPES.includes(f.type) && !/\.(jpe?g|png|webp|heic|heif|gif|avif)$/i.test(f.name)) {
      throw new Error(`${f.name}: formato não permitido.`);
    }
    let s;
    try { s = await dec(f); } catch (e) { throw new Error(`${f.name}: imagem inválida.`); }
    const full = await optimize(s);
    if (!full) throw new Error(`${f.name}: não foi possível processar a imagem.`);

    const localPreview = URL.createObjectURL(full);
    LIVE.add(localPreview);
    const k = 'i:' + (await hash(full));
    if (URLS.has(k)) return { ref: { u: URLS.get(k), k, local: localPreview }, dup: true };

    // ---- Token com refresh preventivo ----
    let session = (await SB.auth.getSession()).data.session;
    if (!session) throw new Error('Sessão expirada. Faça login novamente.');
    if (session.expires_at && session.expires_at * 1000 - Date.now() < 60_000) {
      const { data: refreshData } = await SB.auth.refreshSession();
      if (refreshData?.session) session = refreshData.session;
    }
    const token = session?.access_token;
    if (!token) throw new Error('Sessão expirada. Faça login novamente.');

    const form = new FormData();
    form.append('file', new File([full], 'upload.webp', { type: 'image/webp' }));

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SB_KEY },
      body: form
    });

    let body;
    try { body = await res.json(); }
    catch (e) { throw new Error(`Resposta inválida da Edge Function (${res.status}).`); }

    if (res.status === 401) {
      const { data: refreshData } = await SB.auth.refreshSession();
      if (refreshData?.session) {
        const retry = await fetch(UPLOAD_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshData.session.access_token}`, apikey: SB_KEY },
          body: form,
        });
        let body2;
        try { body2 = await retry.json(); } catch (e) {}
        if (retry.ok && body2?.url) {
          const ref = { u: body2.url, k, local: localPreview };
          URLS.set(k, body2.url);
          return { ref, dup: !!body2.dup };
        }
        throw new Error(body2?.error || 'Sessão expirada. Faça login novamente.');
      }
      throw new Error(body?.error || 'Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) throw new Error(body.error || `Falha no upload (${res.status}).`);

    const ref = { u: body.url, k, local: localPreview };
    URLS.set(k, body.url);
    return { ref, dup: !!body.dup };
  }

  async function hash(blob) {
    const u = new Uint8Array(await blob.arrayBuffer());
    if (window.crypto && crypto.subtle) {
      try {
        const h = await crypto.subtle.digest('SHA-256', u);
        return [...new Uint8Array(h)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
      } catch (e) {}
    }
    let h = 5381;
    for (let i = 0; i < u.length; i += 7) h = ((h << 5) + h + u[i]) | 0;
    return (h >>> 0).toString(16) + u.length.toString(16);
  }

  async function upload(files, onProgress) {
    const refs = [], errs = [];
    let n = 0, dups = 0;
    for (const f of files) {
      try {
        const o = await one(f);
        if (o.dup) dups++;
        refs.push(o.ref);
      } catch (e) { errs.push(e.message || String(e)); }
      onProgress && onProgress(++n, files.length);
    }
    return { refs, errs, dups };
  }

  const ALL_REPOS = ['Sualoja', 'sua loja', 'sua loja '];
  function altRepoUrls(src) {
    const m = src.match(/\/([^/]+)\/img\/(i_[a-f0-9]+\.webp)/i);
    if (!m) return [];
    const fileName = m[2];
    const current = m[1];
    return ALL_REPOS
      .filter((r) => r.toLowerCase() !== current.toLowerCase())
      .map((r) => `https://wendell544.github.io/${r}/img/${fileName}`);
  }

  const html = (r, o = {}) => {
    r = R(r);
    const alt = esc(o.alt || '');
    // eager: força carregamento imediato (fetchpriority high + sem lazy).
    // Indicado dentro do modal, onde as imagens precisam aparecer na hora.
    const eager = o.eager ? ' fetchpriority="high"' : '';
    const lazy = o.eager ? '' : ' loading="lazy"';
    const fallback = art(40);

    if (!r || (!r.u && !r.p && !r.local)) {
      return `<img src="${fallback}" alt="${alt}" class="no-sk" decoding="async"${eager}${lazy}>`;
    }

    const src = (r.local && LIVE.has(r.local) ? r.local : r.u) || '';
    const alts = altRepoUrls(src);
    const altsAttr = alts.length ? ` data-alts='${esc(JSON.stringify(alts))}'` : '';

    const onerr = "var a=JSON.parse(this.dataset.alts||'[]');if(a.length){this.src=a.shift();this.dataset.alts=JSON.stringify(a)}else{this.onerror=null;this.src=this.dataset.fbDefault;this.classList.add('no-sk')}";

    return `<img src="${esc(src)}"${altsAttr} data-fb-default="${fallback}" onerror="${onerr}" alt="${alt}" class="no-sk" decoding="async"${eager}${lazy}>`;
  };

  // Revela uma imagem: remove o shimmer (.sk) e marca como carregada.
  const reveal = (el) => {
    if (!el) return;
    el.classList.remove('sk');
    el.classList.add('no-sk');
  };

  // Hidrata containers .sk: revela quando a imagem carregar (ou imediatamente, se já estiver em cache).
  // Faz DUAS checagens (antes e depois do addEventListener) — protege contra race condition
  // quando a imagem em cache completa entre o innerHTML e o addEventListener.
  const hydrate = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.sk').forEach((el) => {
      const img = el.querySelector('img');
      if (!img) { reveal(el); return; }

      if (img.complete && img.naturalHeight !== 0) { reveal(el); return; }

      img.addEventListener('load', () => reveal(el), { once: true });
      img.addEventListener('error', () => {
        setTimeout(() => { if (!img.naturalHeight) reveal(el); }, 50);
      }, { once: true });

      // Recheca: cache quente pode ter completado entre o if e o addEventListener.
      if (img.complete && img.naturalHeight !== 0) reveal(el);
    });
  };

  async function migrateLegacy() {}

  return { upload, html, hydrate, migrateLegacy };
})();
