import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeExportLoggingSession } from "./services/ExportLogService";

const MIN_SPLASH_MS = 1800;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function hideStartupSplash() {
  const splash = document.getElementById("startup-splash");
  if (!splash) {
    return;
  }

  splash.classList.add("hide");
  window.setTimeout(() => {
    splash.remove();
  }, 250);
}

async function bootstrap() {
  const startedAt = performance.now();

  try {
    await initializeExportLoggingSession();
  } catch (error) {
    console.error("Failed to initialize export log session", error);
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  const elapsed = performance.now() - startedAt;
  if (elapsed < MIN_SPLASH_MS) {
    await delay(MIN_SPLASH_MS - elapsed);
  }

  window.requestAnimationFrame(() => {
    hideStartupSplash();
  });
}

void bootstrap();
