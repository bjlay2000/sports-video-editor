import { createPortal } from "react-dom";
import { useToastStore } from "../../store/toastStore";

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) {
    return null;
  }

  return createPortal(
    <div className="fixed bottom-6 right-6 z-[120] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`min-w-[220px] rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur bg-surface/90 border-white/10 text-white ${
            toast.variant === "success"
              ? "bg-emerald-600/80"
              : toast.variant === "error"
                ? "bg-red-600/80"
                : "bg-gray-700/80"
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>,
    document.body
  );
}
