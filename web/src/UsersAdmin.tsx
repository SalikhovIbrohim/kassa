import { useCallback, useEffect, useState, type FormEvent } from "react";
import { changeAccount, createAccount, deleteAccount, fetchAccounts, NetworkError, SessionExpiredError, type Account, type AccountResult, type City, type Role, CITY_LABEL } from "./api";
import { CitySelect } from "./CitySelect";
import { PencilIcon } from "@/components/icons";
import { alertVariants } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label, LabelNote } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

type Props = {
  /** The login of the admin himself: he cannot block or delete himself, nor take away his own role. */
  me: string;
  onSessionExpired: () => void;
  active?: boolean;
};

const ROLE_LABEL: Record<Role, string> = { cashier: "Кассир", head_cashier: "Главный кассир", viewer: "Смотрящий", admin: "Админ" };
const ROLE_HINT: Record<Role, string> = {
  cashier: "Кассир: вносит приходы и расходы, правит свои записи.",
  head_cashier: "Главный кассир: всё, что кассир, плюс кнопка «Сверить кассу». Сверяет кассу только он.",
  viewer: "Смотрящий (владелец): видит журнал, итоги, сверки, ведёт категории. Ничего не вносит.",
  admin: "Админ: вносит записи, видит всё, что смотрящий, ведёт пользователей. Кассу не сверяет.",
};

const WHY_NOT: Record<Extract<AccountResult, { ok: false }>["reason"], string> = {
  "session-expired": "Нужно войти заново.",
  forbidden: "Пользователей ведёт только админ.",
  "not-found": "Такого пользователя уже нет. Нажмите «Обновить».",
  "login-taken": "Такой логин уже занят.",
  "bad-login": "Логин: от 2 до 64 знаков, буквы, цифры, точка, дефис, подчёркивание, без пробелов.",
  "bad-password": "Пароль: не короче 8 знаков.",
  "bad-name": "Имя не должно быть пустым.",
  self: "Себя нельзя отключить, удалить или лишить роли админа.",
  "has-entries": "У этого человека есть записи в журнале: удалить нельзя, только отключить.",
  rejected: "Проверьте поля: что-то заполнено неверно.",
  "server-error": "Не получилось сохранить. Попробуйте ещё раз.",
};

/**
 * The admin's list of the people of the cash desk, the same way as the categories: «+ Новый» opens a window to add one,
 * the pencil of a row opens everything about that person (name, login, role, password, block, delete).
 */
export function UsersAdmin({ me, onSessionExpired, active = true }: Props) {
  // null: loading, undefined: did not load.
  const [users, setUsers] = useState<Account[] | null | undefined>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The admin may change his own login: he is still himself after that.
  const [myLogin, setMyLogin] = useState(me);

  const load = useCallback(() => {
    fetchAccounts().then(setUsers, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setUsers((current) => current ?? undefined);
    });
  }, [onSessionExpired]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  /** Runs one change and reads the list again. True when it went through. */
  async function apply(work: () => Promise<AccountResult>, success: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await work();
      if (result.ok) {
        setDone(success);
        setEditing(null);
        load();
        return true;
      }
      if (result.reason === "session-expired") onSessionExpired();
      else setError(WHY_NOT[result.reason]);
    } catch (caught) {
      setError(caught instanceof NetworkError ? "Нет связи с сервером. Попробуйте ещё раз, когда она появится." : WHY_NOT["server-error"]);
    } finally {
      setBusy(false);
    }
    return false;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Пользователи" aria-busy={busy}>
      <div className="journal-head">
        <h2>Пользователи</h2>
        <div className="flex gap-2">
          <NewAccount busy={busy} error={error} onOpen={() => setError(null)} onCreate={(input) => apply(() => createAccount(input), `Добавлен ${input.displayName || input.login}.`)} />
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </div>
      <p className="hint">
        Кто входит в Кассу и что может. Новый пароль или отключение сразу выводят человека со всех телефонов. Того, у кого есть записи в журнале, удалить
        нельзя (журнал помнит, кто внёс), его можно только отключить.
      </p>

      {error && (
        <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
          {error}
        </p>
      )}
      {done && <p className={cn(alertVariants({ variant: "success" }), "success")}>{done}</p>}
      {users === null && <p className="hint">Загружаем…</p>}
      {users === undefined && (
        <>
          <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
            Не удалось загрузить список. Проверьте связь и попробуйте ещё раз.
          </p>
          <Button type="button" variant="outline" onClick={load}>
            Повторить
          </Button>
        </>
      )}

      {users && (
        <ul className="divide-y rounded-xl border bg-card shadow-sm">
          {users.map((user) => {
            const self = user.login.toLowerCase() === myLogin.toLowerCase();
            return (
              <li key={user.id} className={cn("flex flex-col gap-3 p-3 transition-colors", editing !== user.id && "hover:bg-muted/60")} data-user={user.login}>
                {editing === user.id ? (
                  <EditAccount
                    user={user}
                    self={self}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(change) =>
                      apply(
                        () => changeAccount(user.id, change),
                        change.password ? (self ? "Сохранено. Пароль сменён: войдите заново." : `Сохранено. Пароль ${user.displayName} сменён: войти можно только с новым.`) : "Сохранено.",
                      ).then((ok) => {
                        if (ok && self && change.login) setMyLogin(change.login);
                        if (ok && self && change.password) onSessionExpired();
                      })
                    }
                    onBlock={() =>
                      void apply(() => changeAccount(user.id, { active: !user.active }), user.active ? `${user.displayName} отключён.` : `${user.displayName} снова может входить.`)
                    }
                    onDelete={() => void apply(() => deleteAccount(user.id), `${user.displayName} удалён.`)}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className={cn("flex flex-wrap items-center gap-1.5 font-semibold", !user.active && "text-muted-foreground line-through")}>
                        {user.displayName}
                        {self && <span className="text-sm font-normal text-muted-foreground">(это вы)</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                        <span>логин: {user.login}</span>
                        <Badge variant="secondary" className="text-xs font-medium">
                          {ROLE_LABEL[user.role]}
                        </Badge>
                        {user.city && (
                          <Badge variant="secondary" className="text-xs font-medium">
                            {CITY_LABEL[user.city]}
                          </Badge>
                        )}
                        {!user.active && (
                          <Badge variant="destructive" className="text-xs font-medium">
                            отключён
                          </Badge>
                        )}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-9"
                      disabled={busy}
                      aria-label={`Изменить: ${user.displayName}`}
                      title="Изменить"
                      onClick={() => {
                        setError(null);
                        setEditing(user.id);
                      }}
                    >
                      <PencilIcon />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RoleField({ value, onChange, disabled }: { value: Role; onChange: (role: Role) => void; disabled?: boolean }) {
  return (
    <Label>
      Роль
      <NativeSelect name="role" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Role)}>
        <option value="cashier">{ROLE_LABEL.cashier}</option>
        <option value="head_cashier">{ROLE_LABEL.head_cashier}</option>
        <option value="viewer">{ROLE_LABEL.viewer}</option>
        <option value="admin">{ROLE_LABEL.admin}</option>
      </NativeSelect>
      <span className="text-sm font-normal text-muted-foreground">{disabled ? "Свою роль админ не меняет." : ROLE_HINT[value]}</span>
    </Label>
  );
}

type Change = { login?: string; displayName?: string; role?: Role; password?: string; city?: City | null };

/** Everything about one person in one place: what to change, and below, to block or delete. */
function EditAccount({
  user,
  self,
  busy,
  onCancel,
  onSave,
  onBlock,
  onDelete,
}: {
  user: Account;
  self: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (change: Change) => Promise<void>;
  onBlock: () => void;
  onDelete: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [login, setLogin] = useState(user.login);
  const [role, setRole] = useState<Role>(user.role);
  const [city, setCity] = useState<City | null>(user.city ?? null);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);

  function save(event: FormEvent) {
    event.preventDefault();
    const change: Change = {
      ...(displayName.trim() === user.displayName ? {} : { displayName: displayName.trim() }),
      ...(login.trim() === user.login ? {} : { login: login.trim() }),
      ...(role === user.role ? {} : { role }),
      ...(city === (user.city ?? null) ? {} : { city }),
      ...(password === "" ? {} : { password }),
    };
    if (Object.keys(change).length === 0) onCancel();
    else void onSave(change);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={save} aria-label={`Изменить ${user.displayName}`}>
      <Label>
        Имя
        <Input name="displayName" autoComplete="off" maxLength={60} required autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </Label>
      <Label>
        Логин
        <Input name="login" autoComplete="off" autoCapitalize="none" maxLength={64} required value={login} onChange={(event) => setLogin(event.target.value)} />
      </Label>
      <RoleField value={role} onChange={setRole} disabled={self} />
      <Label>
        <span>
          Город <LabelNote>(для отчётов и 1С)</LabelNote>
        </span>
        <CitySelect name="city" value={city} onChange={setCity} />
      </Label>
      <Label>
        <span>
          Новый пароль <LabelNote>(пусто: не менять)</LabelNote>
        </span>
        <Input name="password" type="text" autoComplete="new-password" autoCapitalize="none" minLength={8} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
        <span className="text-sm font-normal text-muted-foreground">Не короче 8 знаков. После смены человек выходит со всех телефонов.</span>
      </Label>

      {confirming ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3" role="group" aria-label={`Удалить ${user.displayName}`}>
          <p>
            Удалить {user.displayName} (логин {user.login})? Отменить это нельзя.
          </p>
          <div className="queue-actions">
            <Button type="button" variant="destructive" disabled={busy} onClick={onDelete}>
              Да, удалить
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Нет
            </Button>
          </div>
        </div>
      ) : (
        <div className="queue-actions">
          <Button type="submit" disabled={busy || (password !== "" && password.length < 8)}>
            Сохранить
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Отмена
          </Button>
          {!self && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button type="button" variant={user.active ? "outline" : "default"} disabled={busy} onClick={onBlock}>
                {user.active ? "Отключить" : "Включить"}
              </Button>
              {!user.hasEntries && (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>
                  Удалить
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}

/** «+ Новый»: a window with the name, the login, the password and the role of a new person. */
function NewAccount({
  busy,
  error,
  onOpen,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onCreate: (input: { login: string; displayName: string; password: string; role: Role; city: City | null }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [city, setCity] = useState<City | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await onCreate({ login: login.trim(), displayName: displayName.trim(), password, role, city })) {
      setDisplayName("");
      setLogin("");
      setPassword("");
      setRole("cashier");
      setCity(null);
      setOpen(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          + Новый
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Новый пользователь</DialogTitle>
        <DialogDescription className="sr-only">Имя, логин, пароль и роль человека, который будет входить в Кассу.</DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={add} aria-label="Новый пользователь">
          <Label>
            <span>
              Имя <LabelNote>(как показывать в журнале)</LabelNote>
            </span>
            <Input name="displayName" autoComplete="off" maxLength={60} autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Label>
          <Label>
            <span>
              Логин <LabelNote>(латиницей, без пробелов)</LabelNote>
            </span>
            <Input name="login" autoComplete="off" autoCapitalize="none" maxLength={64} required value={login} onChange={(event) => setLogin(event.target.value)} />
          </Label>
          <Label>
            Пароль
            <Input name="password" type="text" autoComplete="new-password" autoCapitalize="none" minLength={8} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} />
            <span className="text-sm font-normal text-muted-foreground">Не короче 8 знаков.</span>
          </Label>
          <RoleField value={role} onChange={setRole} />
          <Label>
            <span>
              Город <LabelNote>(для отчётов и 1С)</LabelNote>
            </span>
            <CitySelect name="city" value={city} onChange={setCity} />
          </Label>
          {error && (
            <p className={cn(alertVariants({ variant: "destructive" }), "error")} role="alert">
              {error}
            </p>
          )}
          <div className="queue-actions">
            <Button type="submit" disabled={busy || login.trim() === "" || password.length < 8}>
              Добавить
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Отмена
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
