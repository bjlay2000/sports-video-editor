import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const bind = async () => {
      try {
        const appWindow = getCurrentWindow();
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      } catch {
        // Ignore when running without Tauri window context.
      }
    };

    void bind();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const minimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      // noop
    }
  };

  const toggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
      setIsMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // noop
    }
  };

  const closeWindow = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // noop
    }
  };

  return (
    <div
      className="drag-region h-10 border-b border-panel-border bg-surface-dark/95 flex items-center px-3"
      data-tauri-drag-region
    >
      <div className="no-drag flex items-center gap-2">
        <img src="/icon.png" alt="Sports Video Editor" className="h-[24px] w-[24px]" />
        <span className="text-sm text-gray-200">Sports Video Editor</span>
      </div>

      <div className="flex-1" />

      <div className="no-drag flex h-full items-stretch">
        <button
          type="button"
          onClick={minimize}
          className="h-full w-11 flex items-center justify-center text-gray-200 hover:bg-panel-border/70 transition-colors"
          aria-label="Minimize"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          onClick={toggleMaximize}
          className="h-full w-11 flex items-center justify-center text-gray-200 hover:bg-panel-border/70 transition-colors"
          aria-label={isMaximized ? "Restore" : "Maximize"}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3 1h6v6" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={closeWindow}
          className="h-full w-11 flex items-center justify-center text-gray-200 hover:bg-[#e81123] hover:text-white transition-colors"
          aria-label="Close"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
