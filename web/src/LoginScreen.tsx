import { useState, type FormEvent } from "react";
import { logIn, NetworkError, type User } from "./api";

type Props = {
  onLoggedIn: (user: User) => void;
};

/** 30 -> "30 секунд", 60 -> "1 минуту", 150 -> "3 минуты": rounded up, in Russian. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} ${plural(seconds, "секунду", "секунды", "секунд")}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function LoginScreen({ onLoggedIn }: Props) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <form className="card" onSubmit={submit}>
        <h1>Касса</h1>
        <p className="hint">Войдите, чтобы продолжить</p>

        <label>
          Логин
          <input
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
        </label>

        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            enterKeyHint="go"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
