import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBalances,
  fetchCategories,
  fetchCurrentUser,
  logOut,
  NetworkError,
  SessionExpiredError,
  type Balance,
  type Role,
  type User,
} from "./api";
import { Balances, type BalancesState } from "./Balances";
import { EntryScreen } from "./EntryScreen";
import { Journal } from "./Journal";
import { LoginScreen } from "./LoginScreen";
import { plural } from "./plural";
import { QueueBanner } from "./QueueBanner";
import { onQueuedEntrySaved, queue, setQueueLogin, useQueueState } from "./queue-instance";
import { forgetUser, rememberedUser, rememberUser } from "./remembered-user";

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
      (user) => {
        if (user) rememberUser(user);
        else forgetUser();
        setState(user ? { kind: "logged-in", user } : { kind: "logged-out" });
      },
      () => {
        // The server could not be asked. A cashier who was signed in here before can still make
        // entries: they are kept on the phone and go out when the server answers. Whether the
        // session is still alive is found out then.
        const remembered = rememberedUser();
        setState(remembered?.role === "cashier" ? { kind: "logged-in", user: remembered } : { kind: "unreachable" });
      },
    );
  }, []);

  useEffect(load, [load]);

  // The entries kept on the phone are read once, whoever is or is not signed in.
  useEffect(() => {
    void queue.start();
    return () => queue.stop();
  }, []);

  // Stable identity: SignedIn reloads its balances when this changes.
  const showLoggedOut = useCallback(() => {
    forgetUser();
    setState({ kind: "logged-out" });
  }, []);

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
    return (
      <LoginScreen
        onLoggedIn={(user) => {
          rememberUser(user);
          setState({ kind: "logged-in", user });
        }}
      />
    );
  }

  return <SignedIn user={state.user} onLoggedOut={showLoggedOut} />;
}

function SignedIn({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // null: loading, undefined: failed to load, "offline": no connection.
  const [balances, setBalances] = useState<BalancesState>(null);

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
        else setBalances(caught instanceof NetworkError ? "offline" : undefined);
      },
    );
  }, [onLoggedOut]);

  const showSavedBalances = useCallback((fresh: Balance[]) => {
    newest.current++;
    setBalances(fresh);
  }, []);

  useEffect(loadBalances, [loadBalances]);

  // A cashier's entries go out under this login, as soon as the connection is there: when the screen
  // opens, when the phone says it is online again, when the app comes back to the front, and after a
  // while by itself (the queue sees to that).
  const cashier = user.role === "cashier";
  useEffect(() => {
    if (!cashier) return;
    setQueueLogin(user.login);
    const sendWhatWaits = () => void queue.nudge();
    const cameBack = () => {
      if (document.visibilityState === "visible") sendWhatWaits();
    };
    const online = () => {
      sendWhatWaits();
      loadBalances();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", cameBack);
    // So that an expense can be entered later without a connection: the categories are kept on the phone.
    fetchCategories().catch(() => {});
    const stopListening = onQueuedEntrySaved(showSavedBalances);
    sendWhatWaits();
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", cameBack);
      stopListening();
      setQueueLogin(null);
    };
  }, [cashier, user.login, loadBalances, showSavedBalances]);

  const kept = useQueueState().entries.filter((entry) => entry.login === user.login).length;

  async function leave(sure = false) {
    setError(null);
    // Entries that have not reached the server stay on the phone and go out at the next sign-in:
    // say so before leaving, so nobody thinks they are lost (or that they went).
    if (kept > 0 && !sure) {
      setConfirmingLeave(true);
      return;
    }
    setConfirmingLeave(false);
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
        <button type="button" className="secondary small" onClick={() => void leave()}>
          Выйти
        </button>
      </header>

      {confirmingLeave && (
        <div className="queue" role="alertdialog" aria-label="Выход с неотправленными записями">
          <p className="queue-title">
            Не отправлено: {kept} {plural(kept, "запись", "записи", "записей")}
          </p>
          <p>
            Они останутся на этом телефоне и отправятся после вашего следующего входа. Пока они не дошли, их нет ни в
            журнале, ни в остатке.
          </p>
          <div className="queue-actions">
            <button type="button" className="small" onClick={() => void leave(true)}>
              Всё равно выйти
            </button>
            <button type="button" className="secondary small" onClick={() => setConfirmingLeave(false)}>
              Остаться
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <Balances balances={balances} onRetry={loadBalances} />

      {cashier && <QueueBanner login={user.login} onSignIn={onLoggedOut} />}

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
