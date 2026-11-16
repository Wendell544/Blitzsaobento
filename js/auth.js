/* Autenticação via Supabase Auth (e-mail + senha). */
const Auth = (() => {
  async function login(email, password) {
    const { data, error } = await SB.auth.signInWithPassword({ email, password });
    if (error) return { st: 'bad', msg: error.message };
    const user = data.user;
    if (user?.app_metadata?.role !== 'admin') {
      await SB.auth.signOut();
      return { st: 'bad', msg: 'Esta conta não tem permissão de administrador.' };
    }
    return { st: 'ok' };
  }

  async function logout() {
    await SB.auth.signOut();
  }

  async function getSession() {
    try {
      const { data, error } = await SB.auth.getSession();
      if (error) {
        // Se der erro (ex: token inválido), limpa a sessão
        await SB.auth.signOut();
        return null;
      }
      return data.session;
    } catch (e) {
      return null;
    }
  }

  return { login, logout, getSession };
})();
