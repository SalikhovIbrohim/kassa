import { useCallback, useEffect, useState } from "react";
import { fetchCurrentUser, logOut, type Role, type User } from "./api";
import { LoginScreen } from "./LoginScreen";

type State =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "logged-out" }
  | { kind: "logged-in"; user: User };

const ROLE_LABEL: Record<Role, string> = {
  cashier: "Кассир",
  viewer: "Смотрящий",
};

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchCurrentUser().then(
      (user) => setState(user ? { kind: "logged-in", user } : { kind: "logged-out" }),
      () => setState({ kind: "unreachable" }),
    );
  }, []);

  useEffect(load, [load]);

  if (state.kind === "loading") {
    return (
      <main className="screen">
        <p className="hint">Загрузка…</p>
      </main>
    );
  }

  if (state.kind === "unreachable") {
    return (
      <main className="screen">
        <div className="card">
          <h1>Касса</h1>
          <p className="error" role="alert">
            Нет связи с сервером. Проверьте интернет.
          </p>
          <button type="button" onClick={load}>
            Повторить
          </button>
        </div>
      </main>
    );
  }

  if (state.kind === "logged-out") {
    return <LoginScreen onLoggedIn={(user) => setState({ kind: "logged-in", user })} />;
  }

  return <SignedIn user={state.user} onLoggedOut={() => setState({ kind: "logged-out" })} />;
}

function SignedIn({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setError(null);
    try {
      if (await logOut()) {
        onLoggedOut();
        return;
      }
    } catch {
      // fall through to the message below
    }
    // Do not pretend we are logged out while the session is still alive on the server.
    setError("Не удалось выйти: нет связи с сервером. Попробуйте ещё раз.");
  }

  return (
    <main className="screen">
      <div className="card">
        <h1>Касса</h1>
        <p className="who">
          {user.displayName}
          <span className="role">{ROLE_LABEL[user.role]}</span>
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="secondary" onClick={leave}>
          Выйти
        </button>
      </div>
    </main>
  );
}
