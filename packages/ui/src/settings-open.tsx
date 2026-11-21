// Opening Settings from anywhere in the app: the Gateway pane names the
// configured address and offers "Use another gateway" (an address route's
// Review after an approval, setup.md §9).

import { createContext, useContext } from "react";

export const OpenSettingsContext = createContext<(() => void) | null>(null);

/** Opens Settings on its Gateway pane, whichever pane was shown last, or null where none can open. */
export const useOpenSettings = () => useContext(OpenSettingsContext);
