import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeExportLoggingSession } from "./services/ExportLogService";

async function bootstrap() {
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
}

void bootstrap();
