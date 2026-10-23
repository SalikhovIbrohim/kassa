import { useState, type ReactNode } from "react";
import { Icon, SECTIONS, TAB_SLOTS, type SectionKey } from "./sections";
import { KASSA_LABEL, useKassa, type Scope } from "./kassa";
import { THEME_CHOICES, THEME_LABEL, useTheme } from "./theme";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

type Props = {
  displayName: string;
  roleLabel: string;
  login: string;
  /** Every section of this person but «Настройки»: on a phone they open from here. */
  sections: readonly SectionKey[];
  /** The four buttons of the tab bar, and the way to change them. */
  tabs: readonly SectionKey[];
  onTabsChange: (keys: SectionKey[] | null) => void;
  onOpen: (key: SectionKey) => void;
  /** Linking Telegram (inside Telegram only). */
  telegram?: ReactNode;
  onLeave: () => void;
};

const row = "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left";
const listClass = "glass-card divide-y divide-border overflow-hidden rounded-[26px]";
const sectionTitle = "mx-1 mt-2 -mb-1 text-[12px] font-semibold tracking-[.06em] text-muted-foreground uppercase";

/** «Настройки»: who is signed in, every section (on a phone), the tab bar, the theme, the desk, Telegram, «Выйти». */
export function Settings(props: Props) {
  const [theme, setTheme] = useTheme();
  const { choosable, kassa, scope, setScope } = useKassa();
  const [editingTabs, setEditingTabs] = useState(false);
  const others = props.sections.filter((key) => key !== "settings");

  return (
    <div className="mx-auto grid w-full max-w-[560px] gap-3.5">
      <div className="glass-card flex items-center gap-3 rounded-[26px] px-4 py-3.5">
        <span aria-hidden="true" className="grid size-12 flex-none place-items-center rounded-full bg-accent text-base font-semibold text-muted-foreground">
          {props.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-[17px] font-semibold">{props.displayName}</span>
          <span className="truncate text-[13px] text-muted-foreground">
            {props.roleLabel} · {choosable ? "Везде" : KASSA_LABEL[kassa]} · {props.login}
          </span>
        </span>
      </div>

      {/* A phone: the sections that are not on the tab bar open from here. A computer has them in the menu. */}
      <div className="grid gap-3.5 min-[960px]:hidden">
        <h3 className={sectionTitle}>Все разделы</h3>
        <nav aria-label="Все разделы" className={listClass}>
          {others.map((key) => (
            <button key={key} type="button" aria-label={SECTIONS[key].label} className={cn(row, "active:bg-muted")} onClick={() => props.onOpen(key)}>
              <span className="grid size-[38px] flex-none place-items-center rounded-full bg-accent text-muted-foreground">
                <Icon name={SECTIONS[key].icon as never} size={19} />
              </span>
              <span className="flex-1 font-semibold">{SECTIONS[key].label}</span>
              {props.tabs.includes(key) && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">На панели</span>}
              <Icon name="chevronRight" size={18} className="text-faint-foreground" />
            </button>
          ))}
        </nav>
        <div className={listClass}>
          <button type="button" className={cn(row, "active:bg-muted")} onClick={() => setEditingTabs(true)}>
            <span className="grid size-[38px] flex-none place-items-center rounded-full bg-accent text-muted-foreground">
              <Icon name="settings" size={19} />
            </span>
            <span className="grid flex-1 gap-0.5">
              <span className="font-semibold">Настроить нижнюю панель</span>
              <span className="text-[12.5px] text-muted-foreground">Выберите и расставьте {TAB_SLOTS} раздела</span>
            </span>
            <Icon name="chevronRight" size={18} className="text-faint-foreground" />
          </button>
        </div>
      </div>

      <h3 className={sectionTitle}>Другие настройки</h3>
      <div className={listClass}>
        <div className={cn(row, "flex-wrap justify-between")}>
          <span className="font-semibold">Тема</span>
          <Segmented
            label="Тема"
            size="sm"
            className="w-[230px]"
            value={theme}
            onChange={setTheme}
            options={THEME_CHOICES.map((choice) => ({ value: choice, label: choice === "system" ? "Авто" : THEME_LABEL[choice] }))}
          />
        </div>
        {choosable ? (
          <div className={cn(row, "flex-col items-stretch gap-2")}>
            <span className="font-semibold">Касса в журнале и итогах</span>
            <Segmented<Scope>
              label="Касса в журнале и итогах"
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: "both", label: "Обе" },
                { value: "moscow", label: "Москва" },
                { value: "andijan", label: "Андижан" },
              ]}
            />
          </div>
        ) : (
          <div className={cn(row, "justify-between")}>
            <span className="grid gap-0.5">
              <span className="font-semibold">Касса</span>
              <span className="text-[12.5px] text-muted-foreground">Только своя касса</span>
            </span>
            <span className="rounded-full bg-accent px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground">{KASSA_LABEL[kassa]}</span>
          </div>
        )}
        {props.telegram && <div className={row}>{props.telegram}</div>}
        <button type="button" className={cn(row, "justify-between font-semibold text-destructive active:bg-muted")} onClick={props.onLeave}>
          Выйти
          <Icon name="logout" size={19} />
        </button>
      </div>

      <TabsEditor open={editingTabs} onOpenChange={setEditingTabs} sections={others} chosen={props.tabs} onSave={props.onTabsChange} />
    </div>
  );
}

/**
 * The four buttons of the tab bar: the chosen ones in their order (up, down, off), then the rest (on). The fifth button
 * is always «Настройки».
 */
function TabsEditor({
  open,
  onOpenChange,
  sections,
  chosen,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: readonly SectionKey[];
  chosen: readonly SectionKey[];
  onSave: (keys: SectionKey[] | null) => void;
}) {
  const [draft, setDraft] = useState<SectionKey[]>([...chosen]);
  const move = (index: number, by: number) =>
    setDraft((previous) => {
      const next = [...previous];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });
  const rest = sections.filter((key) => !draft.includes(key));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft([...chosen]);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Нижняя панель</DialogTitle>
        <DialogDescription>
          {TAB_SLOTS} кнопки выбираете вы, пятая всегда «Настройки». Порядок меняется стрелками.
        </DialogDescription>
        <ol aria-label="На панели" className="grid gap-1.5">
          {draft.map((key, index) => (
            <li key={key} className="flex items-center gap-2 rounded-[16px] bg-muted px-3 py-2">
              <Icon name={SECTIONS[key].icon as never} size={19} />
              <span className="flex-1 font-semibold">{SECTIONS[key].label}</span>
              <Button type="button" variant="ghost" size="icon" className="size-9" aria-label={`Выше: ${SECTIONS[key].label}`} disabled={index === 0} onClick={() => move(index, -1)}>
                <Icon name="up" size={17} />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-9" aria-label={`Ниже: ${SECTIONS[key].label}`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                <Icon name="down" size={17} />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-9 text-xl" aria-label={`Убрать с панели: ${SECTIONS[key].label}`} disabled={draft.length === 1} onClick={() => setDraft(draft.filter((item) => item !== key))}>
                ×
              </Button>
            </li>
          ))}
        </ol>
        {rest.length > 0 && (
          <ul aria-label="Не на панели" className="grid gap-1.5">
            {rest.map((key) => (
              <li key={key} className="flex items-center gap-2 rounded-[16px] border border-input-edge px-3 py-2 text-muted-foreground">
                <Icon name={SECTIONS[key].icon as never} size={19} />
                <span className="flex-1 font-semibold">{SECTIONS[key].label}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-9"
                  aria-label={`На панель: ${SECTIONS[key].label}`}
                  disabled={draft.length >= TAB_SLOTS}
                  onClick={() => setDraft([...draft, key])}
                >
                  <Icon name="plus" size={17} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onSave(null);
              onOpenChange(false);
            }}
          >
            По умолчанию
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(draft);
              onOpenChange(false);
            }}
          >
            Сохранить
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
