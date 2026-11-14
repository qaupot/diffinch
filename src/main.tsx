import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { preferences } from "./lib/preferences";
import "./styles.css";

document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

void preferences.initialize().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
