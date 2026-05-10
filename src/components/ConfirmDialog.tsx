import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export type ConfirmDialogAction = {
  label: string;
  variant?: "default" | "secondary" | "ghost" | "destructive";
  onClick: () => void;
  disabled?: boolean;
};

export function ConfirmDialog({
  open,
  title,
  description,
  warning,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  description?: string;
  warning?: string;
  children?: ReactNode;
  actions: ConfirmDialogAction[];
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="confirm-dialog-title"
          className="text-lg font-semibold text-white"
        >
          {title}
        </h3>
        {description && (
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">
            {description}
          </p>
        )}
        {warning && (
          <p className="mt-2 text-xs leading-relaxed text-amber-200/90">
            {warning}
          </p>
        )}
        {children}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {actions.map((a, i) => (
            <Button
              key={i}
              type="button"
              variant={a.variant ?? "secondary"}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
