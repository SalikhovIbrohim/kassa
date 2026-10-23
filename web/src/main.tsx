import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "@/components/ui/toast";
import "./index.css";
import { startTheme } from "./theme";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element is missing from index.html");
}

startTheme();

createRoot(container).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);

// Once the app has been opened with a connection, it opens without one. Without this the app still
// works, only not offline.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
