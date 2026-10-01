import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCurrentShift, openShift, SessionExpiredError, type Shift } from "./api";
import { formatMoscowShort } from "./days";
import { formatMoney } from "./money";
import { rememberShift } from "./remembered-shift";

export type ShiftState =
  /** Not asked yet. */
  | { kind: "loading" }
  /** The server could not be asked and nothing is known: the bar says nothing, entries go on as before. */
  | { kind: "unknown" }
  | { kind: "known"; shift: Shift | null };

/** The shift of the cash desk as the cashier's screen knows it, and the means to open one. */
export function useShift(login: string, onSessionExpired: () => void) {
  const [state, setState] = useState<ShiftState>({ kind: "loading" });
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
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

  return { state, opening, problem, open };
}

type Props = {
  login: string;
  state: ShiftState;
  opening: boolean;
  problem: string | null;
  onOpen: () => void;
};

/** What the cashier sees above the forms: whether a shift is open, whose, and the button to open one. */
export function ShiftBar({ login, state, opening, problem, onOpen }: Props) {
  if (state.kind !== "known") return null;
  const { shift } = state;

  return (
    <section className="shift-bar" aria-label="Смена">
      {shift === null ? (
        <>
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
