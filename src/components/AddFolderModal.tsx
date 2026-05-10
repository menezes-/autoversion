import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { addWatchedFolder } from "@/lib/tauri";
import {
  deriveExtensions,
  ExtensionPicker,
  type PresetKey,
} from "@/components/ExtensionPicker";

type PickDirectory = () => Promise<string | null>;

export function AddFolderModal({
  open,
  onClose,
  onAdded,
  pickDirectory,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
  pickDirectory: PickDirectory;
}) {
  const { t } = useTranslation();
  const [dir, setDir] = useState<string | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<Set<PresetKey>>(
    () => new Set<PresetKey>(["word"]),
  );
  const [customEnabled, setCustomEnabled] = useState(false);
  const [customExt, setCustomExt] = useState("");
  const [busy, setBusy] = useState(false);

  const customExtensions = useMemo<string[]>(
    () =>
      customExt
        .split(",")
        .map((s) => s.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
    [customExt],
  );

  const currentExtensions = useMemo(
    () => deriveExtensions(selectedPresets, customEnabled, customExtensions),
    [selectedPresets, customEnabled, customExtensions],
  );

  const resetAndClose = () => {
    setDir(null);
    setSelectedPresets(new Set<PresetKey>(["word"]));
    setCustomEnabled(false);
    setCustomExt("");
    onClose();
  };

  const submit = async () => {
    if (!dir || currentExtensions.length === 0) return;
    setBusy(true);
    try {
      await addWatchedFolder(dir, currentExtensions);
      await onAdded();
      resetAndClose();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-white">
          {t("settings.addFolderModal.title")}
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          {t("wizard.pickFolder.body")}
        </p>
        <div className="mt-4 space-y-2">
          <Button
            type="button"
            onClick={async () => {
              try {
                const picked = await pickDirectory();
                if (picked) setDir(picked);
              } catch (e) {
                alert(String(e));
              }
            }}
          >
            {dir ? t("common.change") : t("wizard.pickFolder.button")}
          </Button>
          {dir && (
            <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-xs text-zinc-200">
              {dir}
            </div>
          )}
        </div>
        <h4 className="mt-6 text-sm font-medium text-zinc-200">
          {t("wizard.extensions.title")}
        </h4>
        <p className="mt-1 text-xs text-zinc-500">{t("wizard.extensions.body")}</p>
        <div className="mt-3">
          <ExtensionPicker
            selectedPresets={selectedPresets}
            onChangeSelectedPresets={setSelectedPresets}
            customEnabled={customEnabled}
            onChangeCustomEnabled={setCustomEnabled}
            customExt={customExt}
            onChangeCustomExt={setCustomExt}
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={resetAndClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!dir || currentExtensions.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? t("common.loading") : t("common.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
