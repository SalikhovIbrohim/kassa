import { KASSA_CURRENCIES, useKassa } from "./kassa";
import { Fragment, useRef, useState, type FormEvent } from "react";
import { AmountInput } from "./AmountInput";
import { Label } from "@/components/ui/label";
import { reconcileCash, SessionExpiredError, type Balance, type Reconciliation } from "./api";
import { formatMoscowShort } from "./days";
import { CURRENCY_NAME, formatMoney, parseCountInput, type Currency } from "./money";
import { useQueueState } from "./queue-instance";
import { Button } from "@/components/ui/button";
import { alertVariants } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type Props = {
  /** The admin who is signed in: what waits on this phone under their login is not in the book yet. */
  login: string;
  /** Called with the balances after a count: what was counted is what the book says now. */
  onBalances: (balances: Balance[]) => void;
  onSessionExpired: () => void;
};

/**
 * The admin's button "Сверить кассу": count the cash in the box, say how much there is of each currency, and the book is
 * brought to what was counted, the difference being written down in the admin's name. Whenever they like, not tied to
 * anything: the cashiers have nothing to open or close.
 */
export function ReconcileBar({ login, onBalances, onSessionExpired }: Props) {
  const [asking, setAsking] = useState(false);
  // The cash desk counted: its currencies; rubles on the cards only where there are rubles (Moscow).
  const { kassa } = useKassa();
  const currencies = KASSA_CURRENCIES[kassa];
  const withCard = currencies.includes("RUB");
  const [counts, setCounts] = useState<Record<Currency, string>>({ RUB: "", USD: "" });
  // The rubles on the cards: the rubles are one, so they count with the cash; kept apart only to say how they are split.
  const [card, setCard] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Reconciliation | null>(null);
  // One id for one count, kept while the same sums are sent again after a lost answer, so that it is made once.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  // What waits on the phone is not in the book yet: a count made now would not agree with it.
  const unsent = useQueueState().entries.filter((entry) => entry.login === login).length;

  function idFor(counted: Balance[], cardMinor: number | undefined): string {
    const key = JSON.stringify([kassa, counted, cardMinor]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    return attempt.current.id;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = currencies.map((currency) => ({ currency, amountMinor: parseCountInput(counts[currency]) }));
    const cardMinor = withCard ? parseCountInput(card) : undefined;
    if (parsed.some((item) => item.amountMinor === null) || cardMinor === null) {
      setError(withCard ? "Введите, сколько насчитали, по каждой валюте и сколько на карте. Если денег нет, введите 0." : "Введите, сколько насчитали. Если денег нет, введите 0.");
      return;
    }
    const counted = parsed as Balance[];
    setBusy(true);
    setError(null);
    try {
      const made = await reconcileCash(idFor(counted, cardMinor), counted, cardMinor, kassa);
      if (made.ok) {
        attempt.current = null;
        setResult(made.reconciliation);
        setAsking(false);
        setCounts({ RUB: "", USD: "" });
        setCard("");
        onBalances(made.balances);
      } else {
        setError(problemText(made.reason));
      }
    } catch (caught) {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setError("Нет связи с сервером. Сверку можно сделать только при связи: попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reconcile-bar rounded-xl border bg-card shadow-sm" aria-label="Сверка кассы">
      {result && <ReconcileResult report={result} onHide={() => setResult(null)} />}
      {!asking ? (
        <div className="reconcile-line">
          <span>
            <strong>Сверка кассы</strong>: пересчитать наличные и свести с книгой
          </span>
          <Button type="button" size="sm" onClick={() => setAsking(true)}>
            Сверить кассу
          </Button>
        </div>
      ) : (
        <form className="reconcile-form" onSubmit={submit} noValidate>
          <p>
            <strong>Сверка кассы.</strong>{" "}
            {withCard
              ? "Пересчитайте деньги и введите, сколько рублей наличными, сколько рублей на карте и сколько долларов. Рубли наличными и на карте считаются вместе. Разница с книгой запишется на вас."
              : "Пересчитайте доллары в кассе и введите, сколько насчитали. Разница с книгой запишется на вас."}
          </p>
          {unsent > 0 && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              На телефоне ещё {unsent === 1 ? "ждёт 1 запись" : `ждут ${unsent} записей`}: их нет в остатке. Дождитесь отправки или решите, что с ними делать, и только потом сверяйте кассу.
            </p>
          )}
          {currencies.map((currency) => (
            <Fragment key={currency}>
              <Label>
                {currency === "RUB" ? "Рубли наличными" : CURRENCY_NAME[currency]}
                <AmountInput
                  name={`count-${currency}`}
                  autoComplete="off"
                  value={counts[currency]}
                  onChange={(text) => setCounts((previous) => ({ ...previous, [currency]: text }))}
                />
              </Label>
              {currency === "RUB" && withCard && (
                <Label>
                  Рубли на карте
                  <AmountInput name="count-card" autoComplete="off" value={card} onChange={setCard} />
                </Label>
              )}
            </Fragment>
          ))}
          {error && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              {error}
            </p>
          )}
          <div className="queue-actions">
            <Button type="submit" disabled={busy || unsent > 0}>
              {busy ? "Сверяем…" : "Сверить кассу"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAsking(false)}>
              Отмена
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function problemText(reason: "forbidden" | "id-conflict" | "rejected" | "server-error"): string {
  switch (reason) {
    case "forbidden":
      return "Сверять кассу может только админ.";
    case "id-conflict":
      return "Эта сверка уже записана с другими суммами. Обновите журнал и проверьте остатки.";
    case "rejected":
      return "Проверьте суммы и попробуйте ещё раз.";
    default:
      return "Сервер не справился. Нажмите кнопку ещё раз: сверка запишется один раз.";
  }
}

/** How a count came out, per currency: what the book said, what was counted, the difference. */
function ReconcileResult({ report, onHide }: { report: Reconciliation; onHide: () => void }) {
  return (
    <div className="reconcile-result rounded-lg bg-secondary" role="status">
      <p>
        <strong>Касса сверена</strong> в {formatMoscowShort(report.madeAt)} (МСК):
      </p>
      <ul>
        {report.currencies.map((item) => (
          <li key={item.currency}>
            {CURRENCY_NAME[item.currency]}: по книге {formatMoney(item.calculatedMinor, item.currency)}, насчитано {formatMoney(item.actualMinor, item.currency)}
            {item.currency === "RUB" && report.cardMinor != null && <> (наличными {formatMoney(item.actualMinor - report.cardMinor, "RUB")}, на карте {formatMoney(report.cardMinor, "RUB")})</>}.{" "}
            <strong className={item.differenceMinor < 0 ? "shortage" : item.differenceMinor > 0 ? "surplus" : "agrees"}>
              {item.differenceMinor === 0 ? "Сошлось." : `${item.differenceMinor < 0 ? "Недостача" : "Излишек"} ${formatMoney(Math.abs(item.differenceMinor), item.currency)}.`}
            </strong>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={onHide}>
        Скрыть
      </Button>
    </div>
  );
}
