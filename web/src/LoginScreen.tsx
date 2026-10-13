import { useState, type FormEvent } from "react";
import { logIn, NetworkError, type User } from "./api";
import { plural } from "./plural";
import { useQueueState } from "./queue-instance";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  onLoggedIn: (user: User) => void;
  /** Something to say above the form, e.g. that this Telegram account is not linked yet. */
  note?: string;
};

/** 30 -> "30 секунд", 60 -> "1 минуту", 150 -> "3 минуты": rounded up, in Russian. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} ${plural(seconds, "секунду", "секунды", "секунд")}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")}`;
}

export function LoginScreen({ onLoggedIn, note }: Props) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entries = useQueueState().entries;
  const blocked = entries.filter((entry) => entry.status === "blocked").length;
  const waiting = entries.length - blocked;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await logIn(login.trim(), password);
      if (result.ok) {
        onLoggedIn(result.user);
        return;
      }
      setError(
        {
          "wrong-credentials": "Неверный логин или пароль.",
          failed: "Не получилось войти. Попробуйте ещё раз.",
          "too-many-attempts":
            result.reason === "too-many-attempts"
              ? `Слишком много неудачных попыток. Подождите ${formatWait(result.retryAfterSeconds)} и попробуйте снова.`
              : "",
          busy: "Сервер сейчас занят проверкой входов. Попробуйте ещё раз через пару секунд.",
        }[result.reason],
      );
    } catch (caught) {
      setError(
        caught instanceof NetworkError
          ? "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз."
          : "Не получилось войти. Попробуйте ещё раз.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <Card asChild className="w-full max-w-[420px] gap-4 p-6">
      <form onSubmit={submit}>
        <div className="grid gap-1">
          <h1 className="text-[2rem] leading-tight font-bold text-primary">Касса</h1>
          <p className="m-0 text-muted-foreground">Войдите, чтобы продолжить</p>
        </div>
        {note && (
          <p className="m-0 text-muted-foreground" role="status">
            {note}
          </p>
        )}

        {waiting > 0 && (
          <p className={cn(alertVariants({ variant: "warning" }), "queued")} role="status">
            На телефоне {plural(waiting, "ждёт", "ждут", "ждут")} отправки: {waiting} {plural(waiting, "запись", "записи", "записей")}.{" "}
            {waiting === 1 ? "Она уйдёт" : "Они уйдут"} сразу после входа кассира, который {waiting === 1 ? "её" : "их"} внёс.
          </p>
        )}
        {blocked > 0 && (
          <p className={cn(alertVariants({ variant: "destructive" }), "queued blocked")} role="status">
            Ещё {blocked} {plural(blocked, "запись", "записи", "записей")} сервер не принял: после входа нужно решить, что с{" "}
            {blocked === 1 ? "ней" : "ними"} делать.
          </p>
        )}

        <Label>
          Логин
          <Input
            name="login"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            required
            value={login}
            onChange={(event) => setLogin(event.target.value)}
          />
        </Label>

        <Label>
          Пароль
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            enterKeyHint="go"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Label>

        {error && (
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" disabled={busy}>
          {busy ? "Входим…" : "Войти"}
        </Button>
      </form>
      </Card>
    </main>
  );
}
