import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BYTES = 5 * 1024 * 1024;
const GITHUB_API = 'https://api.github.com';

// Lê um secret tirando espaços e quebras de linha que sobram ao colar o valor.
const env = (name: string) => (Deno.env.get(name) ?? '').trim();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Token ausente.' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !userData?.user) return json({ error: 'Sessão expirada.' }, 401);
    if (userData.user.app_metadata?.role !== 'admin') return json({ error: 'Acesso negado.' }, 403);

    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.type !== 'image/webp') return json({ error: 'Envie apenas WebP válido.' }, 415);
    if (file.size > MAX_BYTES) return json({ error: 'Arquivo muito grande (>5MB).' }, 413);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const fileName = `i_${hashHex}.webp`;
    const path = `img/${fileName}`;

    // ---- Configuração do GitHub (secrets do Supabase) ----
    // Se o secret existir, ele manda no valor padrão. Por isso os 4 precisam estar certos.
    const ghToken = env('GITHUB_TOKEN');
    const owner = env('GITHUB_OWNER') || 'Wendell544';
    const repo = env('GITHUB_REPO') || 'Sualoja';
    const branch = env('GITHUB_BRANCH'); // vazio = usa a branch padrão do repositório

    if (!ghToken) return json({ error: 'GITHUB_TOKEN não configurado nos secrets.' }, 500);

    const gh: Record<string, string> = {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Sualoja-Upload',
    };

    const where = `${owner}/${repo}`;
    const contentsUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
    const publicUrl = `https://${owner}.github.io/${repo}/${path}`;

    // Se a foto já existe no repositório, reaproveita.
    const checkUrl = branch ? `${contentsUrl}?ref=${encodeURIComponent(branch)}` : contentsUrl;
    const checkRes = await fetch(checkUrl, { headers: gh });
    if (checkRes.ok) return json({ url: publicUrl, dup: true });

    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any);
    }
    const base64 = btoa(bin);

    const payload: Record<string, string> = { message: `upload: ${fileName}`, content: base64 };
    if (branch) payload.branch = branch;

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...gh, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('upload-image: GitHub recusou o envio', putRes.status, errText, { where, branch: branch || '(padrão)' });
      const motivo = await diagnose(gh, owner, repo, branch, putRes.status);
      return json({ error: `${motivo} [GitHub ${putRes.status} · ${where}]`, detail: errText.slice(0, 300) }, 502);
    }

    return json({ url: publicUrl, dup: false });
  } catch (e: any) {
    return json({ error: `Erro inesperado: ${e.message}` }, 500);
  }
});

// Quando o GitHub recusa o envio, descobre o motivo e devolve uma mensagem clara.
async function diagnose(
  gh: Record<string, string>,
  owner: string,
  repo: string,
  branch: string,
  status: number,
): Promise<string> {
  const where = `${owner}/${repo}`;
  try {
    const r = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: gh });

    if (r.status === 401) {
      return 'GITHUB_TOKEN inválido ou expirado. Gere outro token e atualize o secret.';
    }
    if (r.status === 404) {
      return `Repositório ${where} não encontrado para este token. Confira GITHUB_OWNER e GITHUB_REPO (nome exato, sem espaços) e se o token tem acesso a ele.`;
    }
    if (r.ok) {
      const info = await r.json();
      if (info?.permissions?.push === false) {
        return `O token enxerga ${where}, mas não pode escrever nele. Dê a permissão "Contents: Read and write" (fine-grained) ou o escopo "repo" (token clássico).`;
      }
      if (branch) {
        const b = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches/${branch}`, { headers: gh });
        if (b.status === 404) {
          return `A branch "${branch}" não existe em ${where}. A padrão é "${info?.default_branch}": ajuste o secret GITHUB_BRANCH.`;
        }
      }
    }
  } catch (e) {
    console.error('upload-image: diagnóstico falhou', e);
  }

  if (status === 403 || status === 404) {
    return 'O repositório existe, então o token provavelmente não tem permissão de escrita (clássico: escopo "repo"; fine-grained: "Contents: Read and write").';
  }
  return 'O GitHub recusou o envio.';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
