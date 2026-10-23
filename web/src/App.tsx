import { KASSA_CURRENCIES, KassaProvider, useKassa } from "./kassa";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  fetchBalances,
  fetchCategories,
  fetchCurrentUser,
  loginWithTelegram,
  logOut,
  NetworkError,
  SessionExpiredError,
  type Balance,
  type Operation,
  type Role,
  type User,
} from "./api";
import { BalanceNotes, BalanceStrip, ScopeBalances, ScopeSwitch, type BalancesState } from "./Balances";
import { Button } from "@/components/ui/button";
import { EntryScreen, type Section as CashSection } from "./EntryScreen";
import { LoginScreen } from "./LoginScreen";
import { plural } from "./plural";
import { QueueBanner } from "./QueueBanner";
import { keepStorage, onQueuedEntrySaved, queue, setQueueLogin, useQueueState } from "./queue-instance";
import { forgetUser, rememberedUser, rememberUser } from "./remembered-user";
import { CategoriesAdmin } from "./CategoriesAdmin";
import { ClientsAdmin } from "./ClientsAdmin";
import { Journal } from "./Journal";
import { ReconcileBar } from "./ReconcileBar";
import { ReconciliationsList } from "./ReconciliationsList";
import { Settings } from "./Settings";
import { Totals } from "./Totals";
import { UsersAdmin } from "./UsersAdmin";
import { sectionsOf, useTabs, type SectionKey } from "./sections";
import { toast } from "@/components/ui/toast";
import { Shell } from "./Shell";
import { TelegramLink } from "./TelegramLink";
import { inTelegram, startTelegram, telegramLaunchData, useTelegramBackButton, useTelegramClosingConfirmation } from "./telegram";
import { focusWhenShown } from "./focus-when-shown";
import { alertVariants } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type State =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "logged-out" }
  | { kind: "logged-in"; user: User };

const ROLE_LABEL: Record<Role, string> = {
  cashier: "Кассир",
  head_cashier: "Главный кассир",
  admin: "Админ",
  viewer: "Смотрящий",
};

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const unsent = useQueueState().entries.length;
  // Said above the login form: why Telegram did not sign this person in by itself.
  const [telegramNote, setTelegramNote] = useState<string | undefined>(undefined);
  // The login of the screen that is showing, for noticing that somebody else has signed in from another tab.
  const shownLogin = useRef<string | null>(null);
  shownLogin.current = state.kind === "logged-in" ? state.user.login : null;

  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchCurrentUser()
      .then(async (user) => {
        // Opened inside Telegram by an account that is linked to a login: signed in by what Telegram says.
        const launch = telegramLaunchData();
        if (!user && launch) {
          try {
            const result = await loginWithTelegram(launch);
            if (result.ok) return result.user;
            if (result.reason === "not-linked") {
              setTelegramNote("Этот Telegram ещё не привязан к логину. Войдите логином и паролем, а потом нажмите «Привязать Telegram».");
            }
          } catch {
            // no connection: the ordinary login screen says so
          }
        }
        return user;
      })
      .then(
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
        setState(remembered && remembered.role !== "viewer" ? { kind: "logged-in", user: remembered } : { kind: "unreachable" });
      },
    );
  }, []);

  useEffect(load, [load]);

  // Inside Telegram: the official script, the whole screen, the margins and the colors (see telegram.ts).
  useEffect(startTelegram, []);

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
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Нет связи с сервером.
          </p>
          {unsent > 0 && (
            <p className="queued" role="status">
              На телефоне {plural(unsent, "ждёт", "ждут", "ждут")} отправки: {unsent} {plural(unsent, "запись", "записи", "записей")}.
              Не потеряно: {plural(unsent, "она уйдёт", "они уйдут", "они уйдут")}, когда связь появится и войдёт кассир, который {plural(unsent, "её внёс", "их внёс", "их внёс")}.
            </p>
          )}
          <Button type="button" onClick={load}>
            Повторить
          </Button>
        </div>
      </main>
    );
  }

  if (state.kind === "logged-out") {
    return (
      <LoginScreen
        note={telegramNote}
        onLoggedIn={(user) => {
          rememberUser(user);
          setState({ kind: "logged-in", user });
        }}
      />
    );
  }

  return (
    <KassaProvider city={state.user.city}>
      <SignedIn user={state.user} onLoggedOut={showLoggedOut} />
    </KassaProvider>
  );
}

function SignedIn({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // Linking Telegram is offered in the menu until it is done; then a line says so, once.
  const [telegramLinked, setTelegramLinked] = useState(user.telegramLinked ?? false);
  const [justLinked, setJustLinked] = useState(false);
  // null: loading, undefined: failed to load, "offline": no connection.
  const [balances, setBalances] = useState<BalancesState>(null);

  // Numbers the answers we are waiting for: only the newest one may update the screen,
  // so a slow older answer cannot replace a fresher balance.
  const newest = useRef(0);
  // The cash desk shown: its balances in the header, its journal, its forms.
  const { kassa } = useKassa();

  const loadBalances = useCallback(() => {
    const mine = ++newest.current;
    setBalances(null);
    fetchBalances(kassa).then(
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
  }, [onLoggedOut, kassa]);

  const showSavedBalances = useCallback(
    (fresh: Balance[]) => {
      // The answer of a save has the balances of the desk of that entry: an entry of the other desk (one that waited on
      // the phone, say) says nothing about the desk shown, which is read again instead.
      if (fresh.map((item) => item.currency).join() !== KASSA_CURRENCIES[kassa].join()) {
        loadBalances();
        return;
      }
      newest.current++;
      setBalances(fresh);
    },
    [kassa, loadBalances],
  );

  useEffect(loadBalances, [loadBalances]);

  // A cashier's entries go out under this login, as soon as the connection is there: when the screen
  // opens, when the phone says it is online again, when the app comes back to the front, and after a
  // while by itself (the queue sees to that).
  const cashier = user.role !== "viewer";
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

  // One menu for everybody: the sections of the role. On a phone four of them (the person's choice) and «Настройки»
  // are the tab bar; the others open from «Настройки», with the way back.
  const sections = sectionsOf(user.role);
  const { tabs, chosen, setChosen } = useTabs(user.role);
  const computer = useComputer();
  const [section, setSection] = useState<SectionKey>(() => tabs[0]!);
  // Every section is made on first use and then stays alive, only hidden: what was typed into a form, the filters of the
  // journal and the period of the totals are still there when one comes back.
  const [opened, setOpened] = useState<ReadonlySet<SectionKey>>(() => new Set([tabs[0]!]));
  const lastForm = useRef<CashSection>("income");
  if (section === "income" || section === "expense") lastForm.current = section;
  const open = useCallback((key: SectionKey) => {
    setOpened((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));
    setSection(key);
    window.scrollTo({ top: 0 });
  }, []);
  const back = !computer && !tabs.includes(section) ? () => open("settings") : undefined;
  useTelegramBackButton(back);
  useTelegramClosingConfirmation(kept > 0);
  // What the cashier last corrected or deleted in the journal, for the "saved" banners of the forms.
  const [changed, setChanged] = useState<Operation | null>(null);
  // The balances over the journal are read again after a correction in it.
  const [journalBalances, setJournalBalances] = useState(0);
  const refreshJournalBalances = useCallback(() => setJournalBalances((count) => count + 1), []);

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

  const telegram =
    inTelegram() && !telegramLinked ? (
      <TelegramLink
        onLinked={() => {
          setTelegramLinked(true);
          setJustLinked(true);
        }}
      />
    ) : undefined;

  const notices = (
    <>
      {justLinked && (
        <p className="telegram-link" role="status">
          Telegram привязан: в следующий раз Касса откроется без пароля.
        </p>
      )}

      {confirmingLeave && (
        <div
          className="queue rounded-xl border-warning/30 bg-warning-bg text-warning"
          role="alertdialog"
          aria-labelledby="leave-title"
          aria-describedby="leave-text"
          tabIndex={-1}
          ref={focusWhenShown}
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
            <Button type="button" size="sm" onClick={stay}>
              Остаться
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void leave(true)}>
              Всё равно выйти
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}

    </>
  );

  const form = section === "income" || section === "expense";
  const cashierJournal = user.role === "cashier" || user.role === "head_cashier";
  const page = (key: SectionKey, content: ReactNode) =>
    opened.has(key) && (
      <div key={key} hidden={section !== key} className="grid min-w-0 gap-4">
        {content}
      </div>
    );

  return (
    <Shell
      sections={sections}
      tabs={tabs}
      active={section}
      onOpen={open}
      onBack={back}
      compact={form}
      displayName={user.displayName}
      roleLabel={ROLE_LABEL[user.role]}
      onLeave={() => void leave()}
      leaveButton={leaveButton}
    >
      {notices}
      {(opened.has("income") || opened.has("expense")) && (
        // The forms keep the width of a phone.
        <div hidden={!form} className="mx-auto grid w-full max-w-[480px] gap-3">
          <BalanceStrip balances={balances} onRetry={loadBalances} />
          <BalanceNotes balances={balances} onRetry={loadBalances} unsent={kept} />
          <EntryScreen
            section={lastForm.current}
            changed={changed}
            onSaved={(fresh) => {
              toast("Записано");
              showSavedBalances(fresh);
            }}
            onBalancesStale={loadBalances}
            onSessionExpired={onLoggedOut}
          />
          {/* Below what the cashier is typing, so that it appearing and going away does not move the form. */}
          <QueueBanner login={user.login} onSignIn={onLoggedOut} />
        </div>
      )}
      {page(
        "journal",
        <>
          <ScopeSwitch />
          <ScopeBalances onSessionExpired={onLoggedOut} reload={journalBalances} />
          {user.role === "head_cashier" && (
            <section aria-label="Сверка кассы" className="glass-card flex flex-wrap items-center gap-3 rounded-lg px-4 py-3">
              <span className="grid flex-1 leading-snug">
                <strong>Сверка кассы</strong>
                <span className="text-[13px] text-muted-foreground">Пересчитать наличные и свести с книгой</span>
              </span>
              <Button type="button" size="sm" onClick={() => open("reconcile")}>
                Сверить кассу
              </Button>
            </section>
          )}
          {cashierJournal ? (
            <Journal
              mode="cashier"
              login={user.login}
              onSessionExpired={onLoggedOut}
              onRefresh={() => {
                loadBalances();
                refreshJournalBalances();
              }}
              onBalances={(fresh) => {
                showSavedBalances(fresh);
                refreshJournalBalances();
              }}
              onOperationChanged={setChanged}
            />
          ) : (
            // The admin's journal: the owner's view, with the admin's right to correct and delete any entry.
            <Journal
              mode="viewer"
              login={user.role === "admin" ? user.login : undefined}
              isAdmin={user.role === "admin"}
              onSessionExpired={onLoggedOut}
              onRefresh={() => {
                loadBalances();
                refreshJournalBalances();
              }}
              onBalances={() => {
                loadBalances();
                refreshJournalBalances();
              }}
              onOperationChanged={setChanged}
            />
          )}
        </>,
      )}
      {page(
        "reconcile",
        <>
          <ScopeBalances onSessionExpired={onLoggedOut} reload={journalBalances} />
          <ReconcileBar
            login={user.login}
            startAsking
            onBalances={(fresh) => {
              showSavedBalances(fresh);
              refreshJournalBalances();
            }}
            onSessionExpired={onLoggedOut}
          />
        </>,
      )}
      {page(
        "totals",
        <>
          <ScopeSwitch />
          <Totals onSessionExpired={onLoggedOut} onRefresh={loadBalances} active={section === "totals"} />
        </>,
      )}
      {page(
        "reconciliations",
        <>
          <ScopeSwitch />
          <ReconciliationsList onSessionExpired={onLoggedOut} onRefresh={loadBalances} active={section === "reconciliations"} />
        </>,
      )}
      {page("clients", <ClientsAdmin canEdit={user.role === "admin"} onSessionExpired={onLoggedOut} active={section === "clients"} />)}
      {page("categories", <CategoriesAdmin onSessionExpired={onLoggedOut} active={section === "categories"} />)}
      {page("users", <UsersAdmin me={user.login} onSessionExpired={onLoggedOut} active={section === "users"} />)}
      {page(
        "settings",
        <Settings
          displayName={user.displayName}
          roleLabel={ROLE_LABEL[user.role]}
          login={user.login}
          sections={sections}
          tabs={chosen}
          onTabsChange={setChosen}
          onOpen={open}
          telegram={telegram}
          onLeave={() => void leave()}
        />,
      )}
    </Shell>
  );
}

/** A computer (the menu on the left) or a phone (the tab bar): the width of the window says. */
function useComputer(): boolean {
  const query = "(min-width: 960px)";
  const [computer, setComputer] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const changed = () => setComputer(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return computer;
}
