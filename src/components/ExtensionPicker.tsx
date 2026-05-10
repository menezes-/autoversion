import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export const PRESETS = {
  word: ["docx"],
  markdown: ["md", "markdown", "txt"],
  code: [
    "py",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "rs",
    "go",
    "java",
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hh",
    "hpp",
    "rb",
    "cs",
    "kt",
    "swift",
    "php",
    "scala",
    "sh",
    "bash",
    "zsh",
    "fish",
    "sql",
    "r",
    "lua",
    "vim",
    "el",
  ],
  pdf: ["pdf"],
} as const;

export type PresetKey = keyof typeof PRESETS;

const PRESET_KEYS: PresetKey[] = ["word", "markdown", "code", "pdf"];

export function deriveExtensions(
  selectedPresets: Set<PresetKey>,
  customEnabled: boolean,
  customExtensions: string[],
): string[] {
  const out = new Set<string>();
  for (const k of selectedPresets) {
    for (const e of PRESETS[k]) out.add(e);
  }
  if (customEnabled) {
    for (const e of customExtensions) out.add(e);
  }
  return [...out];
}

export type ExtensionPickerProps = {
  selectedPresets: Set<PresetKey>;
  onChangeSelectedPresets: (next: Set<PresetKey>) => void;
  customEnabled: boolean;
  onChangeCustomEnabled: (v: boolean) => void;
  customExt: string;
  onChangeCustomExt: (v: string) => void;
};

export function ExtensionPicker({
  selectedPresets,
  onChangeSelectedPresets,
  customEnabled,
  onChangeCustomEnabled,
  customExt,
  onChangeCustomExt,
}: ExtensionPickerProps) {
  const { t } = useTranslation();

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

  const togglePreset = (k: PresetKey) => {
    const next = new Set(selectedPresets);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChangeSelectedPresets(next);
  };

  return (
    <div className="space-y-2">
      {PRESET_KEYS.map((k) => {
        const active = selectedPresets.has(k);
        return (
          <label
            key={k}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
              active
                ? "border-emerald-500 bg-emerald-950/20"
                : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/70"
            }`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={active}
              onChange={() => togglePreset(k)}
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-zinc-100">
                {t(`wizard.extensions.preset.${k}`)}
              </div>
              <div className="text-xs text-zinc-500">
                {t(`wizard.extensions.preset.${k}Hint`)}
              </div>
            </div>
          </label>
        );
      })}
      <label
        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
          customEnabled
            ? "border-emerald-500 bg-emerald-950/20"
            : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/70"
        }`}
      >
        <input
          type="checkbox"
          className="mt-1"
          checked={customEnabled}
          onChange={(e) => onChangeCustomEnabled(e.target.checked)}
        />
        <div className="flex-1">
          <div className="text-sm font-medium text-zinc-100">
            {t("wizard.extensions.preset.custom")}
          </div>
          <div className="text-xs text-zinc-500">
            {t("wizard.extensions.preset.customHint")}
          </div>
          {customEnabled && (
            <input
              autoFocus
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
              placeholder={t("wizard.extensions.preset.customPlaceholder")}
              value={customExt}
              onChange={(e) => onChangeCustomExt(e.target.value)}
            />
          )}
        </div>
      </label>
      <p className="text-xs text-zinc-500">
        {currentExtensions.length === 0
          ? t("wizard.extensions.noneSelected")
          : t("wizard.extensions.summary", {
              count: currentExtensions.length,
            })}
      </p>
    </div>
  );
}
