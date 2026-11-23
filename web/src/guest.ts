import { createContext, useContext } from "react";

/**
 * True for a guest: somebody who is shown the cash desk. The entry forms are there to be tried, and nothing typed in
 * them is saved, sent or kept on the phone. (The server refuses a guest's entry as well; this is so that it is never sent.)
 */
export const GuestContext = createContext(false);

export const useGuest = () => useContext(GuestContext);

export const GUEST_NOTE = "Гостевой вход: формы можно заполнять, но записи не сохраняются.";
