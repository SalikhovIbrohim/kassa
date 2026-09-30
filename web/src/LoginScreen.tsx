import { useState, type FormEvent } from "react";
import { logIn, NetworkError, type User } from "./api";

type Props = {
  onLoggedIn: (user: User) => void;
};

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
        result.reason === "wrong-credentials"
          ? "Неверный логин или пароль."
          : "Не получилось войти. Попробуйте ещё раз.",
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
