import { useCallback, useEffect, useState } from "react";
import { fetchCategories, SessionExpiredError, type Category } from "./api";

/**
 * The lists of categories for a screen that makes entries: null while they load, undefined when they did not
 * (nothing from the server and nothing kept on the phone), the lists otherwise.
 */
export function useCategories(onSessionExpired: () => void) {
  const [list, setList] = useState<Category[] | null | undefined>(null);
  const reload = useCallback(() => {
    setList(null);
    fetchCategories().then(setList, (caught: unknown) => {
      if (caught instanceof SessionExpiredError) onSessionExpired();
      else setList(undefined);
    });
  }, [onSessionExpired]);
  useEffect(reload, [reload]);
  return { list, reload };
}
