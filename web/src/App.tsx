import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBalances,
  fetchCurrentUser,
  logOut,
  SessionExpiredError,
  type Balance,
  type Role,
  type User,
} from "./api";
import { Balances } from "./Balances";
import { EntryScreen } from "./EntryScreen";
import { Journal } from "./Journal";
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

  // Stable identity: SignedIn reloads its balances when this changes.
  const showLoggedOut = useCallback(() => setState({ kind: "logged-out" }), []);

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

  return <SignedIn user={state.user} onLoggedOut={showLoggedOut} />;
}

function SignedIn({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [error, setError] = useState<string | null>(null);
  // null: loading, undefined: failed to load.
  const [balances, setBalances] = useState<Balance[] | null | undefined>(null);

  // Numbers the answers we are waiting for: only the newest one may update the screen,
  // so a slow older answer cannot replace a fresher balance.
  const newest = useRef(0);

  const loadBalances = useCallback(() => {
    const mine = ++newest.current;
    setBalances(null);
    fetchBalances().then(
      (loaded) => {
        if (mine === newest.current) setBalances(loaded);
      },
      (caught: unknown) => {
        if (mine !== newest.current) return;
        // A dead session means the login screen, not an error message about balances.
        if (caught instanceof SessionExpiredError) onLoggedOut();
        else setBalances(undefined);
      },
    );
  }, [onLoggedOut]);

  const showSavedBalances = useCallback((fresh: Balance[]) => {
    newest.current++;
    setBalances(fresh);
  }, []);

  useEffect(loadBalances, [loadBalances]);

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
    <main className="page">
      <header className="topbar">
        <div>
          <h1>Касса</h1>
          <p className="who">
            {user.displayName}
            <span className="role">{ROLE_LABEL[user.role]}</span>
          </p>
        </div>
        <button type="button" className="secondary small" onClick={leave}>
          Выйти
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <Balances balances={balances} onRetry={loadBalances} />

      {user.role === "cashier" ? (
        <EntryScreen
          onSaved={showSavedBalances}
          onBalancesStale={loadBalances}
          onSessionExpired={onLoggedOut}
        />
      ) : (
        <Journal mode="viewer" onSessionExpired={onLoggedOut} onRefresh={loadBalances} />
      )}
    </main>
  );
}
