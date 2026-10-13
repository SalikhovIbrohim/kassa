import { useState } from "react";
import { CategoriesAdmin } from "./CategoriesAdmin";
import { Journal } from "./Journal";
import { ReconciliationsList } from "./ReconciliationsList";
import { Totals } from "./Totals";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Props = {
  onSessionExpired: () => void;
  /** Called when the person asks for fresh data, so the screen can refresh its balances too. */
  onRefresh: () => void;
};

type Section = "journal" | "totals" | "reconciliations" | "categories";

/** The viewer's (the owner's) screen: the journal of everybody's operations, the totals of a period, the counts of the cash, the lists of categories. Nothing is entered here. */
export function ViewerScreen({ onSessionExpired, onRefresh }: Props) {
  const [section, setSection] = useState<Section>("journal");
  // The other sections are made on first use, and all stay alive, only hidden, while another is open: filters that
  // were set in the journal, and the period chosen for the totals, are still there when the viewer comes back.
  const [opened, setOpened] = useState<ReadonlySet<Section>>(new Set(["journal"]));

  const open = (next: Section) => {
    setOpened((previous) => new Set(previous).add(next));
    setSection(next);
  };

  return (
    <Tabs value={section} onValueChange={(next) => open(next as Section)}>
      <TabsList className="grid grid-cols-4">
        <TabsTrigger value="journal">Журнал</TabsTrigger>
        <TabsTrigger value="totals">Итоги</TabsTrigger>
        <TabsTrigger value="reconciliations">Сверки</TabsTrigger>
        <TabsTrigger value="categories">Категории</TabsTrigger>
      </TabsList>

      <TabsContent value="journal" forceMount>
        <Journal mode="viewer" onSessionExpired={onSessionExpired} onRefresh={onRefresh} />
      </TabsContent>
      <TabsContent value="totals" forceMount>
        {opened.has("totals") && <Totals onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "totals"} />}
      </TabsContent>
      <TabsContent value="reconciliations" forceMount>
        {opened.has("reconciliations") && (
          <ReconciliationsList onSessionExpired={onSessionExpired} onRefresh={onRefresh} active={section === "reconciliations"} />
        )}
      </TabsContent>
      <TabsContent value="categories" forceMount>
        {opened.has("categories") && <CategoriesAdmin onSessionExpired={onSessionExpired} active={section === "categories"} />}
      </TabsContent>
    </Tabs>
  );
}
