import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Warehouse } from "./api";

/**
 * The warehouses where the business puts cargo on its trucks. Which there are is the server's to say (the settings of
 * its installation); with none the business keeps no trips, and the app is the cash desk alone, as it always was.
 */
type Warehouses = {
  warehouses: readonly Warehouse[];
  /** The business keeps trips: the section «Сборные грузы» is there, and the clients have debts. */
  enabled: boolean;
  /** What a warehouse is called; its id, for one the server does not name any more. */
  labelOf: (id: string | null | undefined) => string;
};

const WarehousesContext = createContext<Warehouses>({ warehouses: [], enabled: false, labelOf: (id) => id ?? "" });

export function WarehousesProvider({ warehouses, children }: { warehouses: readonly Warehouse[]; children: ReactNode }) {
  const value = useMemo<Warehouses>(
    () => ({
      warehouses,
      enabled: warehouses.length > 0,
      labelOf: (id) => warehouses.find((item) => item.id === id)?.label ?? id ?? "",
    }),
    [warehouses],
  );
  return <WarehousesContext.Provider value={value}>{children}</WarehousesContext.Provider>;
}

export const useWarehouses = () => useContext(WarehousesContext);
