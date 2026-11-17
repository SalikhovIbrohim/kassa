/** The id of a warehouse, as a line of cargo stores it: "kokand". The city of a person who keeps a warehouse is one. */
export type Warehouse = string;

export type WarehouseInfo = {
  id: Warehouse;
  /** What the screens call it: «Коканд». */
  label: string;
};

/**
 * The warehouses where the business puts cargo on its trucks: its settings name them (`WAREHOUSES`), nothing in the
 * code or in the database does. A business that names none has no groupage at all: the section «Сборные грузы» is
 * not there, and nothing else of the cash desk changes.
 */
export type Warehouses = {
  readonly list: readonly WarehouseInfo[];
  readonly ids: readonly Warehouse[];
  /** The business keeps trips (it has at least one warehouse). */
  readonly enabled: boolean;
  has(id: unknown): id is Warehouse;
  /** What a warehouse is called; its id, for one that is not of the installation any more (an old line). */
  labelOf(id: Warehouse): string;
  /**
   * Whether a person of `city` writes the cargo of `warehouse`: the keeper of a warehouse writes the cargo of their
   * own, and a person of everywhere (no city: the admin) of any.
   */
  mayUse(city: string | null, warehouse: Warehouse): boolean;
};

/** The cities whose names the code knows, so that a settings file can stay in plain Latin letters. */
const KNOWN: ReadonlyMap<string, string> = new Map([
  ["andijan", "Андижан"],
  ["kokand", "Коканд"],
  ["tashkent", "Ташкент"],
  ["moscow", "Москва"],
]);

const MAX_WAREHOUSES = 20;

export function warehousesOf(list: readonly WarehouseInfo[]): Warehouses {
  const byId = new Map(list.map((item) => [item.id, item]));
  return {
    list,
    ids: list.map((item) => item.id),
    enabled: list.length > 0,
    has: (id: unknown): id is Warehouse => typeof id === "string" && byId.has(id),
    labelOf: (id) => byId.get(id)?.label ?? KNOWN.get(id) ?? id,
    mayUse: (city, warehouse) => byId.has(warehouse) && (city === null || city === warehouse),
  };
}

/**
 * Reads the setting `WAREHOUSES`: the warehouses in the order a truck passes them, separated by commas. A city the
 * code knows (andijan, kokand, tashkent, moscow) gets its name by itself; any other is written with its name,
 * `fergana=Фергана`. Without the setting there are none, and the business keeps no trips.
 *
 *   WAREHOUSES=andijan,kokand,tashkent
 */
export function parseWarehouses(setting: string | undefined): Warehouses {
  const text = setting?.trim() ?? "";
  if (text === "") return warehousesOf([]);
  function fail(what: string): never {
    throw new Error(`WAREHOUSES ${what}. It lists the warehouses where cargo is loaded like andijan,kokand,tashkent (a city the code does not know with its name: fergana=Фергана), got "${text}"`);
  }
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) fail("names no warehouse");
  if (parts.length > MAX_WAREHOUSES) fail(`names more than ${MAX_WAREHOUSES} warehouses`);

  const list: WarehouseInfo[] = [];
  for (const part of parts) {
    const found = /^([a-z][a-z0-9_]{0,31})(?:\s*=\s*(.+))?$/.exec(part);
    if (!found) fail(`has a part that is not an id (lower-case Latin letters and digits), "${part}"`);
    const [, id, name] = found as unknown as [string, string, string | undefined];
    if (list.some((item) => item.id === id)) fail(`names the warehouse "${id}" twice`);
    const label = name?.trim() ?? KNOWN.get(id);
    if (label === undefined) fail(`names the warehouse "${id}", a city the code has no name for: write it as ${id}=Название`);
    if (label === "" || label.length > 30 || /[\u0000-\u001f]/.test(label)) fail(`gives the warehouse "${id}" a name that is empty or longer than 30 characters`);
    // A settings file saved in a Windows code page: its Russian letters do not survive being read as UTF-8.
    if (label.includes("�")) fail(`gives the warehouse "${id}" a name that cannot be read: save the settings file as UTF-8`);
    list.push({ id, label });
  }
  return warehousesOf(list);
}

/** An installation whose settings name no warehouse. */
export const NO_WAREHOUSES = parseWarehouses(undefined);
