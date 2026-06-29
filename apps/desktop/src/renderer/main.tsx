import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeTokens } from "./theme";
import "./styles/tokens.css";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Renderer root element is missing.");
}

applyThemeTokens();

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
