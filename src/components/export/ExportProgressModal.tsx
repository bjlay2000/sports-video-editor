import { useAppStore } from "../../store/appStore";

export function ExportProgressModal() {
  const visible = useAppStore((s) => s.exportProgressVisible);
  const title = useAppStore((s) => s.exportProgressTitle);
  const percent = useAppStore((s) => s.exportProgressPercent);
  const status = useAppStore((s) => s.exportProgressStatus);

  if (!visible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-xl border border-panel-border bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-4">
          {title || "Exporting Video"}
        </h2>
        <div className="w-full h-3 rounded-full bg-panel-border/40 overflow-hidden mb-2">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.max(0, Math.min(100, percent)).toFixed(1)}%` }}
          />
        </div>
        <p className="text-xs text-gray-400">
          {status || "Preparing export..."}
        </p>
      </div>
    </div>
  );
}
