import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const ALLOWED_ORIGINS = ['https://wendell544.github.io'];
const GITHUB_API = 'https://api.github.com';

function corsFor(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function jsonFor(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsFor(req) });
  }
  const origin = req.headers.get('Origin') ?? '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return jsonFor(req, { error: 'Origem não permitida.' }, 403);
  }
  if (req.method !== 'POST') {
    return jsonFor(req, { error: 'Método não permitido. Use POST.' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return jsonFor(req, { error: 'Token de autenticação ausente.' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const userClient = createClient(supabaseUrl, supabaseAnonKey);

    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return jsonFor(req, { error: 'Token inválido ou expirado.' }, 401);
    }
    if (userData.user.app_metadata?.role !== 'admin') {
      return jsonFor(req, { error: 'Acesso negado. Apenas administradores.' }, 403);
    }

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    if (!serviceKey) {
      return jsonFor(req, { error: 'SUPABASE_SERVICE_ROLE_KEY não configurada.' }, 500);
    }
    const adminClient = createClient(supabaseUrl, serviceKey);

    const referenced = new Set<string>();
    const collect = (val: unknown) => {
      if (!val) return;
      if (typeof val === 'string') { referenced.add(val); return; }
      if (Array.isArray(val)) {
        val.forEach((v) => {
          if (typeof v === 'string') referenced.add(v);
          else if (v && typeof v === 'object' && 'u' in v && typeof (v as any).u === 'string') {
            referenced.add((v as any).u);
          }
        });
        return;
      }
      if (typeof val === 'object' && 'u' in val && typeof (val as any).u === 'string') {
        referenced.add((val as any).u);
      }
    };

    const tables = [
      { table: 'products', column: 'images' },
      { table: 'banners', column: 'img' },
      { table: 'ads', column: 'img' },
      { table: 'categories', column: 'img' },
    ];

    for (const { table, column } of tables) {
      const { data, error } = await adminClient.from(table).select(column);
      if (error) {
        return jsonFor(req, { error: `Erro ao ler ${table}: ${error.message}` }, 500);
      }
      (data ?? []).forEach((row: any) => collect(row[column]));
    }

    const ghToken = Deno.env.get('GITHUB_TOKEN');
    const owner = Deno.env.get('GITHUB_OWNER');
    const repo = Deno.env.get('GITHUB_REPO');
    const branch = Deno.env.get('GITHUB_BRANCH');

    if (!ghToken || !owner || !repo || !branch) {
      return jsonFor(req, { 
        error: 'Configuração do GitHub incompleta. Verifique os secrets: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH.' 
      }, 500);
    }

    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Blitz-Cleanup-Orphans',
    };

    const listUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/img?ref=${branch}`;
    const listRes = await fetch(listUrl, { headers: ghHeaders });

    if (!listRes.ok) {
      const errText = await listRes.text();
      return jsonFor(req, { error: `Falha ao listar img/: ${listRes.status} ${errText}` }, 502);
    }

    const files = await listRes.json();
    if (!Array.isArray(files)) {
      return jsonFor(req, { error: 'Resposta inesperada da API do GitHub.' }, 502);
    }

    const orphans = files.filter((f: any) => {
      if (f.type !== 'file') return false;
      if (!/^i_[a-f0-9]+\.webp$/.test(f.name)) return false;
      const publicUrl = `https://${owner}.github.io/${repo}/img/${f.name}`;
      return !referenced.has(publicUrl);
    });

    const removed: string[] = [];
    const errors: string[] = [];

    for (const file of orphans) {
      const delUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/img/${file.name}`;
      const delRes = await fetch(delUrl, {
        method: 'DELETE',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `cleanup: remove órfão ${file.name}`,
          sha: file.sha,
          branch,
        }),
      });

      if (delRes.ok) {
        removed.push(file.name);
      } else {
        const errText = await delRes.text();
        errors.push(`${file.name}: ${delRes.status} ${errText}`);
      }
    }

    return jsonFor(req, {
      removed,
      kept: files.length - orphans.length,
      total: files.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    console.error('cleanup-orphans erro inesperado:', e);
    return jsonFor(req, { 
      error: `Erro inesperado: ${e instanceof Error ? e.message : String(e)}` 
    }, 500);
  }
});
