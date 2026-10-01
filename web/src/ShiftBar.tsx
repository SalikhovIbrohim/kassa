import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { closeShift, fetchCurrentShift, openShift, SessionExpiredError, type Shift, type ShiftReport } from "./api";
import { formatMoscowShort } from "./days";
import { CURRENCIES, CURRENCY_NAME, formatMoney, parseCountInput, type Currency } from "./money";
import { useQueueState } from "./queue-instance";
import { rememberShift } from "./remembered-shift";

export type ShiftState =
  /** Not asked yet. */
  | { kind: "loading" }
  /** The server could not be asked and nothing is known: the bar says nothing, entries go on as before. */
  | { kind: "unknown" }
  | { kind: "known"; shift: Shift | null };

/** The shift of the cash desk as the cashier's screen knows it, and the means to open one. */
export function useShift(login: string, onSessionExpired: () => void, onBalancesStale: () => void) {
  const [state, setState] = useState<ShiftState>({ kind: "loading" });
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // How the count of the cash came out when the shift was closed here: shown until the next shift is opened.
  const [lastClosed, setLastClosed] = useState<ShiftReport | null>(null);
  // Numbers the questions, so only the newest answer counts.
  const newest = useRef(0);

  const learn = useCallback(
    (shift: Shift | null) => {
      setState({ kind: "known", shift });
      // The phone keeps the shift that is the cashier's own, so that an entry made without a connection belongs to it.
      rememberShift(login, shift && shift.cashier.login === login ? shift.id : null);
    },
    [login],
  );

  const reload = useCallback(() => {
    const mine = ++newest.current;
    fetchCurrentShift().then(
      (shift) => {
        if (mine === newest.current) learn(shift);
      },
      (caught: unknown) => {
        if (mine !== newest.current) return;
        if (caught instanceof SessionExpiredError) onSessionExpired();
        else setState((current) => (current.kind === "known" ? current : { kind: "unknown" }));
      },
    );
  }, [learn, onSessionExpired]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The cashier comes back to the app, or the connection returns: the shift may have changed meanwhile.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
  }, [reload]);

  const open = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setProblem(null);
    try {
      const result = await openShift();
      const shift = result.shift;
      if (shift) setLastClosed(null);
      if (shift) learn(shift);
      else reload();
      if (!result.ok && shift && shift.cashier.login !== login) {
        setProblem(`Смену уже открыл ${shift.cashier.displayName}. Одновременно может быть открыта только одна.`);
      }
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setProblem("Не удалось открыть смену. Проверьте связь и попробуйте ещё раз.");
    } finally {
      setOpening(false);
    }
  }, [opening, learn, reload, login, onSessionExpired]);

  /** Closes the open shift with the count. Resolves with what to tell the cashier when it did not work, else null. */
  const close = useCallback(
    async (shiftId: string, counted: Array<{ currency: Currency; amountMinor: number }>): Promise<string | null> => {
      try {
        const result = await closeShift(shiftId, counted);
        if (result.ok) {
          setLastClosed(result.shift);
          learn(null);
          // What was counted is what the books say now.
          onBalancesStale();
          return null;
        }
        switch (result.reason) {
          case "already-closed":
            reload();
            return "Эта смена уже закрыта с другим подсчётом. Обновите экран.";
          case "not-yours":
            return "Закрыть смену может только кассир, который её открыл.";
          case "not-found":
            reload();
            return "Такой смены нет. Обновите экран.";
          case "rejected":
            return "Проверьте суммы и попробуйте ещё раз.";
          default:
            return "Сервер не справился. Нажмите кнопку ещё раз: смена закроется один раз.";
        }
      } catch (caught) {
        if (caught instanceof SessionExpiredError) {
          onSessionExpired();
          return null;
        }
        return "Нет связи с сервером. Смену можно закрыть только при связи: попробуйте ещё раз.";
      }
    },
    [learn, reload, onBalancesStale, onSessionExpired],
  );

  return { state, opening, problem, open, close, lastClosed };
}

type Props = {
  login: string;
  state: ShiftState;
  opening: boolean;
  problem: string | null;
  lastClosed: ShiftReport | null;
  onOpen: () => void;
  onClose: (shiftId: string, counted: Array<{ currency: Currency; amountMinor: number }>) => Promise<string | null>;
};

/** What the cashier sees above the forms: whether a shift is open, whose, and the buttons to open or close one. */
export function ShiftBar({ login, state, opening, problem, lastClosed, onOpen, onClose }: Props) {
  if (state.kind !== "known") return null;
  const { shift } = state;

  return (
    <section className="shift-bar" aria-label="Смена">
      {shift === null ? (
        <>
          {lastClosed && <ClosedResult report={lastClosed} />}
          <p className="shift-line">
            <strong>Смена не открыта.</strong> Откройте её, чтобы записи попали в смену и в сверку.
          </p>
          <button type="button" className="small" disabled={opening} onClick={onOpen}>
            {opening ? "Открываем…" : "Открыть смену"}
          </button>
        </>
      ) : shift.cashier.login === login ? (
        <>
          <p className="shift-line">
            <strong>Смена открыта</strong> с {formatMoscowShort(shift.openedAt)} (МСК).
          </p>
          <p className="shift-opening">
            Остаток на начало: {shift.openingBalances.map((item) => formatMoney(item.amountMinor, item.currency)).join(" · ")}
          </p>
          <CloseShift login={login} shiftId={shift.id} onClose={onClose} />
        </>
      ) : (
        <p className="shift-line">
          <strong>Открыта смена кассира {shift.cashier.displayName}</strong> с {formatMoscowShort(shift.openedAt)} (МСК). Ваши записи в неё не попадут.
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** How a closed shift came out, per currency: what the books said, what was counted, the difference. */
function ClosedResult({ report }: { report: ShiftReport }) {
  return (
    <div className="shift-result" role="status">
      <p className="shift-line">
        <strong>Смена закрыта</strong> в {formatMoscowShort(report.closedAt ?? report.openedAt)} (МСК). Сверка:
      </p>
      <ul>
        {report.currencies.map((item) => {
          const difference = item.differenceMinor ?? 0;
          return (
            <li key={item.currency}>
              {CURRENCY_NAME[item.currency]}: по книге {formatMoney(item.calculatedMinor ?? 0, item.currency)}, насчитано{" "}
              {formatMoney(item.actualMinor ?? 0, item.currency)}.{" "}
              <strong className={difference < 0 ? "shortage" : difference > 0 ? "surplus" : "agrees"}>
                {difference === 0 ? "Сошлось." : `${difference < 0 ? "Недостача" : "Излишек"} ${formatMoney(Math.abs(difference), item.currency)}.`}
              </strong>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The button that closes the shift, and the form in which the cashier says what was counted in the cash desk. */
function CloseShift({
  login,
  shiftId,
  onClose,
}: {
  login: string;
  shiftId: string;
  onClose: Props["onClose"];
}) {
  const [asking, setAsking] = useState(false);
  const [counts, setCounts] = useState<Record<Currency, string>>({ RUB: "", USD: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What waits on the phone is not in the books yet: a count made now would not agree with them.
  const unsent = useQueueState().entries.filter((entry) => entry.login === login).length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const counted = CURRENCIES.map((currency) => ({ currency, amountMinor: parseCountInput(counts[currency]) }));
    if (counted.some((item) => item.amountMinor === null)) {
      setError("Введите, сколько насчитали, по каждой валюте. Если денег нет, введите 0.");
      return;
    }
    setBusy(true);
    setError(null);
    const problem = await onClose(shiftId, counted as Array<{ currency: Currency; amountMinor: number }>);
    setBusy(false);
    if (problem) setError(problem);
  }

  if (!asking) {
    return (
      <button type="button" className="secondary small" onClick={() => setAsking(true)}>
        Закрыть смену
      </button>
    );
  }

  return (
    <form className="close-shift" onSubmit={submit} noValidate>
      <p className="shift-line">
        <strong>Закрытие смены.</strong> Пересчитайте наличные и введите, сколько денег лежит в кассе, по каждой валюте.
      </p>
      {unsent > 0 && (
        <p className="error" role="alert">
          На телефоне ещё {unsent === 1 ? "ждёт 1 запись" : `ждут ${unsent} записей`}: их нет в остатке. Дождитесь отправки или решите, что с ними делать, и только потом закрывайте смену.
        </p>
      )}
      {CURRENCIES.map((currency) => (
        <label key={currency}>
          В кассе, {CURRENCY_NAME[currency].toLowerCase()}
          <input
            name={`count-${currency}`}
            inputMode="decimal"
            autoComplete="off"
            value={counts[currency]}
            onChange={(event) => setCounts((previous) => ({ ...previous, [currency]: event.target.value }))}
          />
        </label>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="queue-actions">
        <button type="submit" disabled={busy || unsent > 0}>
          {busy ? "Закрываем…" : "Закрыть смену"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(false)}>
          Отмена
        </button>
      </div>
    </form>
  );
}
