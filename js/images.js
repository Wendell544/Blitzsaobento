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

    const { data: { session } } = await SB.auth.getSession();
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

    if (res.status === 401) throw new Error('Sessão expirada. Faça login novamente.');
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

  // Se a URL for do repo novo (Sualoja) mas a foto estiver no antigo (ou vice-versa),
  // tenta o outro repositório antes de desistir.
  function altRepoUrl(src) {
    if (!/\/img\/i_[a-f0-9]+\.webp/i.test(src)) return '';
    if (src.includes('/Sualoja/'))        return src.replace('/Sualoja/', '/Blitzsaobento/');
    if (src.includes('/Blitzsaobento/'))  return src.replace('/Blitzsaobento/', '/Sualoja/');
    if (src.includes('/Bilinhajoias/'))   return src.replace('/Bilinhajoias/', '/Sualoja/');
    return '';
  }

  const html = (r, o = {}) => {
    r = R(r);
    const alt = esc(o.alt || '');
    const eager = o.eager ? ' fetchpriority="high"' : '';
    const fallback = art(40);

    if (!r || (!r.u && !r.p && !r.local)) {
      return `<img src="${fallback}" alt="${alt}" class="no-sk" decoding="async"${eager}${o.eager ? '' : ' loading="lazy"'}>`;
    }

    const src = (r.local && LIVE.has(r.local) ? r.local : r.u) || '';
    const fb = altRepoUrl(src);

    // onerror em 2 estágios: 1) tenta o outro repo → 2) cai no SVG padrão
    const onerr = "if(this.dataset.retried){this.onerror=null;this.src=this.dataset.fbDefault;this.classList.add('no-sk')}else{this.dataset.retried='1';this.src=this.dataset.fb||this.dataset.fbDefault}";
    const fbAttr = fb ? ` data-fb="${esc(fb)}"` : '';

    return `<img src="${esc(src)}"${fbAttr} data-fb-default="${fallback}" onerror="${onerr}" alt="${alt}" class="no-sk" decoding="async"${eager}${o.eager ? '' : ' loading="lazy"'}>`;
  };

  const hydrate = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.sk').forEach((el) => {
      const img = el.querySelector('img');
      if (img && img.complete && img.naturalHeight !== 0) {
        el.classList.remove('sk'); el.classList.add('no-sk');
      } else if (img) {
        img.addEventListener('load', () => { el.classList.remove('sk'); el.classList.add('no-sk'); }, { once: true });
        img.addEventListener('error', () => { el.classList.remove('sk'); el.classList.add('no-sk'); }, { once: true });
      }
    });
  };

  async function migrateLegacy() {}

  return { upload, html, hydrate, migrateLegacy };
})();
