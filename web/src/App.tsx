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
import { keepStorage, onQueuedEntrySaved, queue, setQueueLogin, useQueueState } from "./queue-instance";
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
  const unsent = useQueueState().entries.length;
  // The login of the screen that is showing, for noticing that somebody else has signed in from another tab.
  const shownLogin = useRef<string | null>(null);
  shownLogin.current = state.kind === "logged-in" ? state.user.login : null;

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
    queue.start().catch((error) => console.error("The entries on the phone could not be read:", error));
    return () => queue.stop();
  }, []);

  // Another tab of this browser signed in as somebody else (the cookie is shared by all of them, so
  // this tab's entries would go out under that session): look again at who is signed in.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "kassa.user" || shownLogin.current === null) return;
      if (rememberedUser()?.login !== shownLogin.current) load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [load]);

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
            Нет связи с сервером.
          </p>
          {unsent > 0 && (
            <p className="queued" role="status">
              На телефоне {plural(unsent, "ждёт", "ждут", "ждут")} отправки: {unsent} {plural(unsent, "запись", "записи", "записей")}.
              Не потеряно: {plural(unsent, "она уйдёт", "они уйдут", "они уйдут")}, когда связь появится и войдёт кассир, который {plural(unsent, "её внёс", "их внёс", "их внёс")}.
            </p>
          )}
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
    // The entries that wait live only in this browser's storage: ask it not to clear them when short of room.
    keepStorage();
    const stopListening = onQueuedEntrySaved(showSavedBalances);
    sendWhatWaits();
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", cameBack);
      stopListening();
      setQueueLogin(null);
    };
  }, [cashier, user.login, loadBalances, showSavedBalances]);

  const mine = useQueueState().entries.filter((entry) => entry.login === user.login);
  const kept = mine.length;
  const blockedCount = mine.filter((entry) => entry.status === "blocked").length;
  const waitingCount = kept - blockedCount;
  const leaveButton = useRef<HTMLButtonElement>(null);

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
    setError(
      `Выйти можно только при связи с сервером. Пока вы вошли как ${user.displayName}: новые записи пойдут от этого имени.`,
    );
  }

  function stay() {
    setConfirmingLeave(false);
    leaveButton.current?.focus();
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
        <button ref={leaveButton} type="button" className="secondary small" onClick={() => void leave()}>
          Выйти
        </button>
      </header>

      {confirmingLeave && (
        <div
          className="queue"
          role="alertdialog"
          aria-labelledby="leave-title"
          aria-describedby="leave-text"
          tabIndex={-1}
          ref={(node) => node?.focus()}
        >
          <p className="queue-title" id="leave-title">
            Не отправлено: {kept} {plural(kept, "запись", "записи", "записей")}
          </p>
          <div id="leave-text" className="queue-text">
            {waitingCount > 0 && (
              <p>
                {waitingCount === 1 ? "Она останется" : "Они останутся"} на этом телефоне и {waitingCount === 1 ? "уйдёт" : "уйдут"} после
                вашего следующего входа. Пока {waitingCount === 1 ? "она не дошла, её нет" : "они не дошли, их нет"} ни в журнале, ни в остатке.
              </p>
            )}
            {blockedCount > 0 && (
              <p>
                Ещё {blockedCount} {plural(blockedCount, "запись", "записи", "записей")} сервер не принял.{" "}
                {blockedCount === 1 ? "Сама она не уйдёт" : "Сами они не уйдут"}: нужно решить, отправить {blockedCount === 1 ? "её" : "их"} снова или удалить.
              </p>
            )}
          </div>
          <div className="queue-actions">
            <button type="button" className="small" onClick={stay}>
              Остаться
            </button>
            <button type="button" className="secondary small" onClick={() => void leave(true)}>
              Всё равно выйти
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <Balances balances={balances} onRetry={loadBalances} unsent={cashier ? kept : 0} />

      {user.role === "cashier" ? (
        <EntryScreen
          onSaved={showSavedBalances}
          onBalancesStale={loadBalances}
          onSessionExpired={onLoggedOut}
        />
      ) : (
        <Journal mode="viewer" onSessionExpired={onLoggedOut} onRefresh={loadBalances} />
      )}

      {/* Below what the cashier is typing, so that it appearing and going away does not move the form. */}
      {cashier && <QueueBanner login={user.login} onSignIn={onLoggedOut} />}
    </main>
  );
}
