import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import {
  format as formatDate,
  formatDistanceToNow,
  isToday,
  isYesterday,
  parseISO,
} from "date-fns";
import { enUS, ptBR } from "date-fns/locale";
import type { Locale } from "date-fns";
import mammoth from "mammoth";
import { AddFolderModal } from "@/components/AddFolderModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  deriveExtensions,
  ExtensionPicker,
  type PresetKey,
} from "@/components/ExtensionPicker";
import { TwoPaneLineDiff } from "@/components/TwoPaneLineDiff";
import { Button } from "@/components/ui/button";
import {
  onConfigChanged,
  onRestoreCompleted,
  onSnapshotCreated,
  onWatcherError,
} from "@/lib/events";
import { findFormatEntry, type DiffKind } from "@/lib/formats";
import {
  addWatchedFolder,
  bytesToUtf8,
  getConfig,
  getCurrentContent,
  getSnapshotContent,
  getStatus,
  getStorageUsage,
  listRecentChanges,
  listSnapshots,
  listWatchedFiles,
  openWatchedFile,
  pauseWatching,
  previewFolderMatches,
  deleteFolderSnapshots,
  getSystemSnapshotParent,
  removeWatchedFolder,
  restoreSnapshot,
  resumeWatching,
  revealPath,
  setConfig,
  setDefaultSnapshotRoot,
  setFolderSnapshotRoot,
  updateWatchedFolder,
  type ActivityEntry,
  type Config,
  type FileEntry,
  type Snapshot,
} from "@/lib/tauri";

type Nav = "folders" | "activity" | "settings" | "help" | "about";
type CompareMode = "previous" | "current" | "pick";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function dateLocale(lang: string | undefined): Locale {
  if (lang && lang.toLowerCase().startsWith("pt")) return ptBR;
  return enUS;
}

/** Map i18next's `language` (e.g. `pt`) to our supported radio value `pt-BR`. */
function normalizeUiLang(lng: string | undefined): "en" | "pt-BR" {
  if (!lng) return "en";
  const l = lng.toLowerCase();
  if (l === "pt-br" || l.startsWith("pt")) return "pt-BR";
  return "en";
}

async function pickDirectory(): Promise<string | null> {
  console.log("[pickDirectory] start");
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.warn("[pickDirectory] focus before dialog failed:", e);
  }
  const result = await open({ directory: true, multiple: false });
  if (typeof result === "string" && result) return result;
  return null;
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block size-3 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-200 ${className}`}
      aria-hidden
    />
  );
}

function App() {
  const { t, i18n } = useTranslation();

  // react-i18next's internal subscription has been flaky for us in dev (Tauri webview
  // + StrictMode). Force a full re-render of the tree whenever the language changes,
  // so every `t(...)` call recomputes regardless of useTranslation's behavior.
  const [, setLangTick] = useState(0);
  useEffect(() => {
    const onChanged = () => setLangTick((n) => n + 1);
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, [i18n]);

  const locale = dateLocale(i18n.resolvedLanguage);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [nav, setNav] = useState<Nav>("folders");
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [selectedSnap, setSelectedSnap] = useState<Snapshot | null>(null);
  const [compare, setCompare] = useState<CompareMode>("previous");
  const [comparePickSha, setComparePickSha] = useState<string | null>(null);
  const [leftBytes, setLeftBytes] = useState<number[]>([]);
  const [rightBytes, setRightBytes] = useState<number[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      setCfg(await getConfig());
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubs: Array<() => void> = [];
    void onConfigChanged(() => void refresh()).then((u) => unsubs.push(u));
    void onSnapshotCreated((p) => {
      void refresh();
      if (selectedFolderId && p.folderId === selectedFolderId && selectedFile) {
        void listSnapshots(selectedFolderId, selectedFile).then(setSnaps);
      }
    }).then((u) => unsubs.push(u));
    void onWatcherError((p) => {
      setErr(p.message);
      void sendNotification({ title: "AutoVersion", body: p.message });
    }).then((u) => unsubs.push(u));
    void onRestoreCompleted((p) => {
      setToast(t("folders.restoreToast", { sha: p.restoredFromSha.slice(0, 7) }));
      setTimeout(() => setToast(null), 4000);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [refresh, selectedFile, selectedFolderId, t]);

  useEffect(() => {
    if (!selectedFolderId) {
      setFiles([]);
      return;
    }
    void listWatchedFiles(selectedFolderId)
      .then(setFiles)
      .catch((e) => setErr(String(e)));
  }, [selectedFolderId, cfg?.watchedFolders]);

  useEffect(() => {
    if (!selectedFolderId || !selectedFile) {
      setSnaps([]);
      setSelectedSnap(null);
      return;
    }
    setLoadingSnaps(true);
    listSnapshots(selectedFolderId, selectedFile)
      .then((rows) => {
        setSnaps(rows);
        // Auto-select the most recent snapshot so the diff pane has something
        // to render immediately. Without this, the user sees "no snapshots"
        // even though the list has rows.
        setSelectedSnap((current) => {
          if (rows.length === 0) return null;
          const stillThere =
            current && rows.find((r) => r.commitSha === current.commitSha);
          return stillThere ?? rows[0] ?? null;
        });
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingSnaps(false));
  }, [selectedFolderId, selectedFile, cfg?.watchedFolders]);

  useEffect(() => {
    if (!selectedFolderId || !selectedFile || !selectedSnap) {
      setLeftBytes([]);
      setRightBytes([]);
      return;
    }
    const idx = snaps.findIndex((s) => s.commitSha === selectedSnap.commitSha);
    const prev = idx >= 0 && idx + 1 < snaps.length ? snaps[idx + 1] : null;

    const load = async () => {
      setLoadingDiff(true);
      try {
        if (compare === "current") {
          const cur = await getCurrentContent(selectedFolderId, selectedFile);
          const old = await getSnapshotContent(
            selectedFolderId,
            selectedSnap.commitSha,
            selectedFile,
          );
          setLeftBytes(old);
          setRightBytes(cur);
        } else if (compare === "pick" && comparePickSha) {
          const a = await getSnapshotContent(
            selectedFolderId,
            comparePickSha,
            selectedFile,
          );
          const b = await getSnapshotContent(
            selectedFolderId,
            selectedSnap.commitSha,
            selectedFile,
          );
          setLeftBytes(a);
          setRightBytes(b);
        } else if (prev) {
          const a = await getSnapshotContent(
            selectedFolderId,
            prev.commitSha,
            selectedFile,
          );
          const b = await getSnapshotContent(
            selectedFolderId,
            selectedSnap.commitSha,
            selectedFile,
          );
          setLeftBytes(a);
          setRightBytes(b);
        } else {
          const b = await getSnapshotContent(
            selectedFolderId,
            selectedSnap.commitSha,
            selectedFile,
          );
          setLeftBytes(b);
          setRightBytes(b);
        }
      } catch (e) {
        setErr(String(e));
      } finally {
        setLoadingDiff(false);
      }
    };
    void load();
  }, [
    compare,
    comparePickSha,
    selectedFile,
    selectedFolderId,
    selectedSnap,
    snaps,
  ]);

  const diffKind: DiffKind = useMemo(() => {
    const ext = selectedFile?.split(".").pop() ?? "";
    return findFormatEntry(ext).diffKind;
  }, [selectedFile]);

  const onRestore = useCallback(async () => {
    if (!selectedFolderId || !selectedFile || !selectedSnap) return;
    const ext = selectedFile.split(".").pop()?.toLowerCase() ?? "";
    const docxExtra = ext === "docx" ? "\n\n" + t("folders.docxWarning") : "";
    if (
      !confirm(
        t("folders.restoreConfirm", { file: selectedFile }) + docxExtra,
      )
    ) {
      return;
    }
    setRestoring(true);
    try {
      await restoreSnapshot(
        selectedFolderId,
        selectedSnap.commitSha,
        selectedFile,
      );
      const fresh = await listSnapshots(selectedFolderId, selectedFile);
      setSnaps(fresh);
      const stillThere = fresh.find((s) => s.commitSha === selectedSnap.commitSha);
      setSelectedSnap(stillThere ?? fresh[0] ?? null);
      if (compare === "current") {
        try {
          const cur = await getCurrentContent(selectedFolderId, selectedFile);
          setRightBytes(cur);
        } catch {
          /* file may have been deleted; ignore */
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setRestoring(false);
    }
  }, [compare, selectedFile, selectedFolderId, selectedSnap, t]);

  const diffPaneLabels = useMemo(() => {
    if (compare === "current") {
      return {
        left: t("folders.diff.leftSnapshot"),
        right: t("folders.diff.rightDisk"),
      };
    }
    if (compare === "pick") {
      return {
        left: t("folders.diff.leftPicked"),
        right: t("folders.diff.rightPicked"),
      };
    }
    return {
      left: t("folders.diff.leftPrevious"),
      right: t("folders.diff.rightSelected"),
    };
  }, [compare, t]);

  const renderDiff = () => {
    if (!selectedFile) {
      return (
        <p className="text-sm text-zinc-500">{t("folders.pickFile")}</p>
      );
    }
    if (loadingSnaps || (loadingDiff && !selectedSnap)) {
      return (
        <p className="text-sm text-zinc-500">
          <Spinner className="mr-2" />
          {t("folders.loadingHistory")}
        </p>
      );
    }
    if (!selectedSnap) {
      // Distinguish "this file has snapshots, just pick one" from the genuine
      // empty case. snaps.length is the source of truth here.
      const message =
        snaps.length === 0
          ? t("folders.noSnapshots")
          : t("folders.pickSnapshot");
      return <p className="text-sm text-zinc-500">{message}</p>;
    }
    const left = bytesToUtf8(leftBytes);
    const right = bytesToUtf8(rightBytes);
    if (diffKind === "opaqueBinary") {
      return (
        <div className="space-y-2 text-sm text-zinc-300">
          <p>{t("folders.metaOnly")}</p>
          <p>{t("folders.leftBytes", { n: leftBytes.length })}</p>
          <p>{t("folders.rightBytes", { n: rightBytes.length })}</p>
        </div>
      );
    }
    if (diffKind === "docx") {
      return (
        <DocxDiff
          left={leftBytes}
          right={rightBytes}
          leftLabel={diffPaneLabels.left}
          rightLabel={diffPaneLabels.right}
        />
      );
    }
    if (left === right) {
      if (snaps.length <= 1) {
        return (
          <pre className="max-h-[480px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
            {right || " "}
          </pre>
        );
      }
      return (
        <p className="text-sm text-zinc-500">{t("folders.noDifferences")}</p>
      );
    }
    return (
      <TwoPaneLineDiff
        leftLabel={diffPaneLabels.left}
        rightLabel={diffPaneLabels.right}
        left={left}
        right={right}
      />
    );
  };

  if (!cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-400">
        <Spinner className="mr-2" />
        {t("common.loading")}
      </div>
    );
  }

  if (cfg.watchedFolders.length === 0) {
    return (
      <Wizard
        cfg={cfg}
        onDone={() => {
          void refresh();
        }}
      />
    );
  }

  const navItems: Nav[] = ["folders", "activity", "settings", "help", "about"];

  return (
    <div
      key={i18n.resolvedLanguage ?? i18n.language ?? "en"}
      className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100"
    >
      {toast && (
        <div className="border-b border-emerald-900/40 bg-emerald-950/50 px-4 py-2 text-sm text-emerald-100">
          {toast}
        </div>
      )}
      {err && (
        <div className="flex items-start gap-2 border-b border-red-900/40 bg-red-950/40 px-4 py-2 text-sm text-red-100">
          <span className="flex-1">{err}</span>
          <button
            type="button"
            onClick={() => setErr(null)}
            className="text-xs text-red-200 underline-offset-2 hover:underline"
          >
            {t("common.close")}
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-48 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
          <div className="border-b border-zinc-800 p-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            AutoVersion
          </div>
          {navItems.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setNav(k)}
              className={`px-3 py-2 text-left text-sm transition-colors ${
                nav === k
                  ? "border-l-2 border-emerald-500 bg-zinc-800 pl-[10px] text-white"
                  : "text-zinc-400 hover:bg-zinc-800/60"
              }`}
            >
              {t(`nav.${k}`)}
            </button>
          ))}
        </aside>
        <main className="flex-1 overflow-auto p-4">
          {nav === "folders" && (
            <FoldersPane
              cfg={cfg}
              locale={locale}
              selectedFolderId={selectedFolderId}
              setSelectedFolderId={setSelectedFolderId}
              files={files}
              selectedFile={selectedFile}
              setSelectedFile={setSelectedFile}
              snaps={snaps}
              loadingSnaps={loadingSnaps}
              selectedSnap={selectedSnap}
              setSelectedSnap={setSelectedSnap}
              compare={compare}
              setCompare={setCompare}
              comparePickSha={comparePickSha}
              setComparePickSha={setComparePickSha}
              renderDiff={renderDiff}
              restoring={restoring}
              onRestore={onRestore}
            />
          )}
          {nav === "activity" && (
            <ActivityPane
              locale={locale}
              onOpen={(entry) => {
                setSelectedFolderId(entry.folderId);
                setSelectedFile(entry.relativePath);
                setSelectedSnap({
                  commitSha: entry.commitSha,
                  timestamp: entry.timestamp,
                  addedLines: entry.addedLines,
                  removedLines: entry.removedLines,
                  isBinary: entry.isBinary,
                  byteDelta: entry.byteDelta,
                  isTombstone: entry.isTombstone,
                });
                setCompare("previous");
                setNav("folders");
              }}
            />
          )}
          {nav === "settings" && (
            <SettingsPane cfg={cfg} onReload={refresh} />
          )}
          {nav === "help" && <HelpPane />}
          {nav === "about" && (
            <div className="max-w-lg space-y-2 text-sm text-zinc-300">
              <h2 className="text-lg font-semibold text-white">
                {t("about.title")}
              </h2>
              <p>{t("about.description")}</p>
              <p className="text-zinc-500">{t("about.gatekeeper")}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function DocxDiff({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  left: number[];
  right: number[];
  leftLabel: string;
  rightLabel: string;
}) {
  const { t } = useTranslation();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Mammoth crashes with "End of data reached / Corrupted zip ?" on empty
      // input (which happens for tombstoned snapshots when the right side is a
      // missing file). Skip the parse and treat empty as empty text.
      const extract = async (bytes: number[]): Promise<string> => {
        if (bytes.length === 0) return "";
        const u8 = Uint8Array.from(bytes);
        const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        try {
          const r = await mammoth.extractRawText({ arrayBuffer: buf });
          return r.value;
        } catch (e) {
          console.warn("[DocxDiff] mammoth parse failed", e);
          return "";
        }
      };
      const [l, r] = await Promise.all([extract(left), extract(right)]);
      if (!cancelled) {
        setA(l);
        setB(r);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [left, right]);
  if (a === b) {
    return (
      <p className="text-sm text-zinc-500">{t("folders.noDifferences")}</p>
    );
  }
  return (
    <TwoPaneLineDiff
      leftLabel={leftLabel}
      rightLabel={rightLabel}
      left={a}
      right={b}
    />
  );
}

// ----------------------------- Wizard -----------------------------

function Wizard({
  cfg,
  onDone,
}: {
  cfg: Config;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  // Same forced re-render trick as the main shell, in case the wizard is on screen
  // while the user changes language (rare, but cheap to support).
  const [, setLangTick] = useState(0);
  useEffect(() => {
    const onChanged = () => setLangTick((n) => n + 1);
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, [i18n]);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<string | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<Set<PresetKey>>(
    () => new Set<PresetKey>(["word"]),
  );
  const [customEnabled, setCustomEnabled] = useState(false);
  const [customExt, setCustomExt] = useState("");
  const [startAtLogin, setStartAtLogin] = useState(cfg.startAtLogin);
  const [busy, setBusy] = useState(false);

  const total = 5; // language, welcome, pickFolder, extensions, confirm

  const customExtensions = useMemo<string[]>(
    () =>
      customExt
        .split(",")
        .map((s) => s.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
    [customExt],
  );

  const currentExtensions = useMemo<string[]>(
    () => deriveExtensions(selectedPresets, customEnabled, customExtensions),
    [selectedPresets, customEnabled, customExtensions],
  );

  const canNext = useMemo(() => {
    if (step === 2) return !!dir;
    if (step === 3) return currentExtensions.length > 0;
    return true;
  }, [step, dir, currentExtensions]);

  const finish = async () => {
    if (!dir) return;
    setBusy(true);
    try {
      await addWatchedFolder(dir, currentExtensions);
      if (startAtLogin !== cfg.startAtLogin) {
        const fresh = await getConfig();
        await setConfig({ ...fresh, startAtLogin });
      }
      try {
        await sendNotification({
          title: "AutoVersion",
          body: `Now protecting ${dir.split("/").pop() ?? dir}`,
        });
      } catch {
        /* notification permission may be denied; non-fatal */
      }
      onDone();
    } catch (e) {
      alert(`Couldn't finish setup: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            AutoVersion
          </span>
          <div className="flex gap-1.5">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  i <= step ? "bg-emerald-500" : "bg-zinc-700"
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-zinc-500">
            {t("wizard.step", { n: step + 1, total })}
          </span>
        </div>
        {step > 0 && step < total - 1 && (
          <button
            type="button"
            onClick={() => setStep(total - 1)}
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-200 hover:underline"
          >
            {t("common.skip")}
          </button>
        )}
      </header>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-10">
        {step === 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-white">
              {t("wizard.language.title")}
            </h2>
            <p className="text-sm leading-relaxed text-zinc-300">
              {t("wizard.language.body")}
            </p>
            <div className="space-y-2">
              {(["en", "pt-BR"] as const).map((lng) => {
                const active = normalizeUiLang(i18n.language) === lng;
                return (
                  <label
                    key={lng}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                      active
                        ? "border-emerald-500 bg-emerald-950/20"
                        : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/70"
                    }`}
                  >
                    <input
                      type="radio"
                      name="wizard-lang"
                      checked={active}
                      onChange={() => void i18n.changeLanguage(lng)}
                    />
                    <span className="text-sm font-medium text-zinc-100">
                      {lng === "en"
                        ? t("settings.languageEnglish")
                        : t("settings.languagePortuguese")}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}
        {step === 1 && (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold leading-tight text-white">
              {t("wizard.welcome.title")}
            </h1>
            <p className="text-sm leading-relaxed text-zinc-300">
              {t("wizard.welcome.body")}
            </p>
          </section>
        )}
        {step === 2 && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-white">
              {t("wizard.pickFolder.title")}
            </h2>
            <p className="text-sm leading-relaxed text-zinc-300">
              {t("wizard.pickFolder.body")}
            </p>
            <div className="space-y-2">
              <Button
                type="button"
                onClick={async () => {
                  try {
                    const picked = await pickDirectory();
                    if (picked) setDir(picked);
                  } catch (e) {
                    alert(`Couldn't open folder picker: ${String(e)}`);
                  }
                }}
              >
                {dir ? t("common.change") : t("wizard.pickFolder.button")}
              </Button>
              {dir && (
                <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm">
                  <span className="text-zinc-500">
                    {t("wizard.pickFolder.picked")}
                  </span>
                  <span className="font-mono text-xs text-zinc-200">{dir}</span>
                </div>
              )}
            </div>
          </section>
        )}
        {step === 3 && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-white">
              {t("wizard.extensions.title")}
            </h2>
            <p className="text-sm leading-relaxed text-zinc-300">
              {t("wizard.extensions.body")}
            </p>
            <ExtensionPicker
              selectedPresets={selectedPresets}
              onChangeSelectedPresets={setSelectedPresets}
              customEnabled={customEnabled}
              onChangeCustomEnabled={setCustomEnabled}
              customExt={customExt}
              onChangeCustomExt={setCustomExt}
            />
          </section>
        )}
        {step === 4 && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-white">
              {t("wizard.confirm.title")}
            </h2>
            <p
              className="text-sm leading-relaxed text-zinc-300"
              dangerouslySetInnerHTML={{
                __html: t("wizard.confirm.summary", {
                  folder: dir
                    ? escapeHtml(dir.split("/").pop() ?? dir)
                    : "—",
                  exts: escapeHtml(currentExtensions.join(", ") || "—"),
                }),
              }}
            />
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={startAtLogin}
                onChange={(e) => setStartAtLogin(e.target.checked)}
              />
              {t("wizard.confirm.startAtLogin")}
            </label>
          </section>
        )}
      </div>
      <footer className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
        <Button
          type="button"
          variant="ghost"
          disabled={step === 0 || busy}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          {t("common.back")}
        </Button>
        {step < total - 1 ? (
          <Button
            type="button"
            disabled={!canNext}
            onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
          >
            {step === 1 ? t("wizard.welcome.next") : t("common.next")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!dir || busy || currentExtensions.length === 0}
            onClick={() => void finish()}
          >
            {busy && <Spinner className="mr-2" />}
            {t("wizard.confirm.finish")}
          </Button>
        )}
      </footer>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ----------------------------- Folders pane -----------------------------

function StatBadge({
  snap,
  className = "",
}: {
  snap: Pick<Snapshot, "addedLines" | "removedLines" | "isBinary" | "isTombstone">;
  className?: string;
}) {
  const { t } = useTranslation();
  if (snap.isTombstone) {
    return (
      <span
        className={`rounded bg-red-950/40 px-1.5 py-0.5 text-[10px] uppercase text-red-200 ${className}`}
      >
        {t("folders.stats.deleted")}
      </span>
    );
  }
  if (snap.isBinary) {
    return (
      <span
        className={`rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300 ${className}`}
      >
        {t("folders.stats.modified")}
      </span>
    );
  }
  if (snap.addedLines === 0 && snap.removedLines === 0) {
    return null;
  }
  return (
    <span className={`flex gap-1 text-[10px] font-mono ${className}`}>
      {snap.addedLines > 0 && (
        <span className="rounded bg-emerald-950/40 px-1.5 py-0.5 text-emerald-200">
          +{snap.addedLines}
        </span>
      )}
      {snap.removedLines > 0 && (
        <span className="rounded bg-red-950/40 px-1.5 py-0.5 text-red-200">
          -{snap.removedLines}
        </span>
      )}
    </span>
  );
}

function CopyShaButton({ sha }: { sha: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sha);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be denied; fail silently */
        }
      }}
      className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:border-zinc-500"
      title={sha}
    >
      {copied ? t("common.copied") : sha.slice(0, 7)}
    </button>
  );
}

function FoldersPane({
  cfg,
  locale,
  selectedFolderId,
  setSelectedFolderId,
  files,
  selectedFile,
  setSelectedFile,
  snaps,
  loadingSnaps,
  selectedSnap,
  setSelectedSnap,
  compare,
  setCompare,
  comparePickSha,
  setComparePickSha,
  renderDiff,
  restoring,
  onRestore,
}: {
  cfg: Config;
  locale: Locale;
  selectedFolderId: string | null;
  setSelectedFolderId: (id: string | null) => void;
  files: FileEntry[];
  selectedFile: string | null;
  setSelectedFile: (p: string | null) => void;
  snaps: Snapshot[];
  loadingSnaps: boolean;
  selectedSnap: Snapshot | null;
  setSelectedSnap: (s: Snapshot | null) => void;
  compare: CompareMode;
  setCompare: (c: CompareMode) => void;
  comparePickSha: string | null;
  setComparePickSha: (s: string | null) => void;
  renderDiff: () => ReactNode;
  restoring: boolean;
  onRestore: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const fileBaseName = selectedFile
    ? selectedFile.split("/").pop() ?? selectedFile
    : null;

  return (
    <div className="grid h-full min-h-[560px] grid-cols-12 gap-3">
      <section className="col-span-3 flex flex-col gap-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <h3 className="px-1 text-xs font-semibold uppercase text-zinc-500">
          {t("nav.folders")}
        </h3>
        {cfg.watchedFolders.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          const active = selectedFolderId === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setSelectedFolderId(f.id);
                setSelectedFile(null);
                setSelectedSnap(null);
              }}
              className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                active
                  ? "border-l-2 border-emerald-500 bg-zinc-800 pl-[6px] text-white"
                  : "text-zinc-400 hover:bg-zinc-800/50"
              }`}
              title={f.path}
            >
              <div className="truncate font-medium">{name}</div>
              <div className="truncate text-[10px] text-zinc-500">{f.path}</div>
            </button>
          );
        })}
      </section>
      <section className="col-span-3 space-y-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <h3 className="px-1 text-xs font-semibold uppercase text-zinc-500">
          {t("folders.filesColumn")}
        </h3>
        {!selectedFolderId && (
          <p className="px-1 text-xs text-zinc-500">{t("folders.emptyFolder")}</p>
        )}
        {selectedFolderId && files.length === 0 && (
          <p className="px-1 text-xs text-zinc-500">{t("folders.noFiles")}</p>
        )}
        {files.map((f) => (
          <button
            key={f.relativePath}
            type="button"
            onClick={() => {
              setSelectedFile(f.relativePath);
              setSelectedSnap(null);
            }}
            className={`block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors ${
              selectedFile === f.relativePath
                ? "border-l-2 border-emerald-500 bg-zinc-800 pl-[6px] text-white"
                : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            {f.relativePath}
          </button>
        ))}
      </section>
      <section className="col-span-6 flex flex-col gap-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-zinc-500">
            {t("folders.compare.label")}
          </label>
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
            value={compare}
            onChange={(e) => setCompare(e.target.value as CompareMode)}
          >
            <option value="previous">{t("folders.compare.previous")}</option>
            <option value="current">{t("folders.compare.current")}</option>
            <option value="pick">{t("folders.compare.pick")}</option>
          </select>
          {compare === "pick" && (
            <select
              className="max-w-[200px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
              value={comparePickSha ?? ""}
              onChange={(e) => setComparePickSha(e.target.value || null)}
            >
              <option value="">{t("folders.compare.selectCommit")}</option>
              {snaps.map((s) => (
                <option key={s.commitSha} value={s.commitSha}>
                  {s.commitSha.slice(0, 7)} —{" "}
                  {formatDistanceToNow(parseISO(s.timestamp), {
                    addSuffix: true,
                    locale,
                  })}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-xs"
            disabled={!selectedFolderId || !selectedFile}
            title={selectedFile ?? undefined}
            onClick={() => {
              if (!selectedFolderId || !selectedFile) return;
              void openWatchedFile(selectedFolderId, selectedFile).catch((e) => {
                alert(`Couldn't open file: ${String(e)}`);
              });
            }}
          >
            {t("folders.openFile")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="text-xs"
            disabled={!selectedSnap || restoring}
            onClick={() => void onRestore()}
          >
            {restoring && <Spinner className="mr-2" />}
            {restoring ? t("folders.restoring") : t("folders.restore")}
          </Button>
        </div>
        <div className="max-h-44 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40">
          {loadingSnaps && (
            <div className="space-y-1 p-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-9 animate-pulse rounded bg-zinc-900/60"
                />
              ))}
            </div>
          )}
          {!loadingSnaps && selectedFile && snaps.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-500">
              {t("folders.noSnapshots")}
            </p>
          )}
          {!loadingSnaps && !selectedFile && (
            <p className="px-3 py-2 text-xs text-zinc-500">
              {t("folders.pickFile")}
            </p>
          )}
          {!loadingSnaps &&
            snaps.map((s) => {
              const active = selectedSnap?.commitSha === s.commitSha;
              return (
                <button
                  key={s.commitSha}
                  type="button"
                  onClick={() => setSelectedSnap(s)}
                  className={`block w-full border-b border-zinc-800 px-3 py-2 text-left text-xs transition-colors last:border-0 ${
                    active
                      ? "border-l-2 border-emerald-500 bg-zinc-800/80 pl-[10px] text-white"
                      : "text-zinc-300 hover:bg-zinc-800/40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate">
                      {formatDistanceToNow(parseISO(s.timestamp), {
                        addSuffix: true,
                        locale,
                      })}
                    </span>
                    <StatBadge snap={s} />
                    <span
                      className="font-mono text-[10px] text-zinc-500"
                      title={formatDate(parseISO(s.timestamp), "PPpp", { locale })}
                    >
                      {s.commitSha.slice(0, 7)}
                    </span>
                  </div>
                </button>
              );
            })}
        </div>
        {selectedSnap && fileBaseName && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
            <span className="font-mono text-zinc-200">{fileBaseName}</span>
            <span className="text-zinc-600">·</span>
            <CopyShaButton sha={selectedSnap.commitSha} />
            <span className="text-zinc-600">·</span>
            <span title={formatDate(parseISO(selectedSnap.timestamp), "PPpp", { locale })}>
              {formatDistanceToNow(parseISO(selectedSnap.timestamp), {
                addSuffix: true,
                locale,
              })}
            </span>
            <StatBadge snap={selectedSnap} className="ml-auto" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">{renderDiff()}</div>
      </section>
    </div>
  );
}

// ----------------------------- Activity pane -----------------------------

function ActivityPane({
  locale,
  onOpen,
}: {
  locale: Locale;
  onOpen: (entry: ActivityEntry) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    listRecentChanges(200)
      .then((rows) => {
        setEntries(rows);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    void onSnapshotCreated(() => {
      if (!cancelled) load();
    }).then((u) => unsubs.push(u));
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [load]);

  if (err) {
    return <p className="text-sm text-red-300">{err}</p>;
  }
  if (entries === null) {
    return (
      <p className="text-sm text-zinc-500">
        <Spinner className="mr-2" />
        {t("activity.loading")}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="mx-auto max-w-md space-y-2 p-10 text-center text-sm text-zinc-400">
        <h2 className="text-lg font-semibold text-white">
          {t("activity.title")}
        </h2>
        <p>{t("activity.empty")}</p>
      </div>
    );
  }

  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const d = parseISO(e.timestamp);
    let key: string;
    if (isToday(d)) key = t("activity.today");
    else if (isYesterday(d)) key = t("activity.yesterday");
    else key = formatDate(d, "PPP", { locale });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold text-white">
          {t("activity.title")}
        </h2>
        <p className="text-xs text-zinc-500">{t("activity.subtitle")}</p>
      </header>
      {[...groups.entries()].map(([day, rows]) => (
        <section key={day} className="space-y-1">
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {day}
          </h3>
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            {rows.map((entry, i) => {
              const fileBase =
                entry.relativePath.split("/").pop() ?? entry.relativePath;
              return (
                <button
                  key={`${entry.commitSha}:${entry.relativePath}:${i}`}
                  type="button"
                  onClick={() => onOpen(entry)}
                  className="flex w-full items-center gap-3 border-b border-zinc-800 bg-zinc-900/30 px-3 py-2 text-left text-sm transition-colors last:border-0 hover:bg-zinc-800/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-zinc-200">
                      {fileBase}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {entry.folderName}
                      {entry.relativePath !== fileBase && (
                        <span className="text-zinc-600">
                          {" · "}
                          {entry.relativePath}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatBadge snap={entry} />
                  <span
                    className="w-28 shrink-0 text-right text-xs text-zinc-500"
                    title={formatDate(parseISO(entry.timestamp), "PPpp", {
                      locale,
                    })}
                  >
                    {formatDistanceToNow(parseISO(entry.timestamp), {
                      addSuffix: true,
                      locale,
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ----------------------------- Settings pane -----------------------------

function snapshotParentForFolder(
  f: Config["watchedFolders"][number],
  cfg: Config,
  systemDefaultParent: string,
): string {
  return (
    f.snapshotRootOverride ??
    cfg.defaultSnapshotRoot ??
    systemDefaultParent
  );
}

type PendingSnapshotMove =
  | { kind: "folder"; folderId: string; newParent: string | null }
  | { kind: "default"; newParent: string | null };

type RemoveFolderTarget = { id: string; path: string };

function SettingsPane({
  cfg,
  onReload,
}: {
  cfg: Config;
  onReload: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [previewById, setPreviewById] = useState<Record<string, string>>({});
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [systemParent, setSystemParent] = useState<string>("");
  const [pendingMove, setPendingMove] = useState<PendingSnapshotMove | null>(
    null,
  );
  const [removeTarget, setRemoveTarget] = useState<RemoveFolderTarget | null>(
    null,
  );
  const [locationBusy, setLocationBusy] = useState(false);

  useEffect(() => {
    void getSystemSnapshotParent()
      .then(setSystemParent)
      .catch(() => setSystemParent(""));
  }, []);

  const applyPendingMove = async (moveExisting: boolean) => {
    if (!pendingMove || locationBusy) return;
    setLocationBusy(true);
    try {
      if (pendingMove.kind === "folder") {
        await setFolderSnapshotRoot(
          pendingMove.folderId,
          pendingMove.newParent,
          moveExisting,
        );
      } else {
        await setDefaultSnapshotRoot(pendingMove.newParent, moveExisting);
      }
      setPendingMove(null);
      await onReload();
    } catch (e) {
      alert(String(e));
    } finally {
      setLocationBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h2 className="text-lg font-semibold text-white">{t("settings.title")}</h2>

      <AddFolderModal
        open={addFolderOpen}
        onClose={() => setAddFolderOpen(false)}
        onAdded={() => onReload()}
        pickDirectory={pickDirectory}
      />

      <ConfirmDialog
        open={pendingMove !== null}
        title={t("settings.moveDialog.title")}
        description={t("settings.moveDialog.body")}
        warning={t("settings.moveDialog.dontMoveWarning")}
        actions={[
          {
            label: t("common.cancel"),
            variant: "ghost",
            onClick: () => {
              if (!locationBusy) setPendingMove(null);
            },
          },
          {
            label: t("settings.moveDialog.dontMove"),
            variant: "secondary",
            onClick: () => void applyPendingMove(false),
            disabled: locationBusy,
          },
          {
            label: locationBusy ? t("common.loading") : t("settings.moveDialog.move"),
            variant: "default",
            onClick: () => void applyPendingMove(true),
            disabled: locationBusy,
          },
        ]}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={t("settings.removeDialog.title")}
        description={t("settings.removeDialog.body", {
          path: removeTarget?.path ?? "",
        })}
        actions={[
          {
            label: t("common.cancel"),
            variant: "ghost",
            onClick: () => setRemoveTarget(null),
          },
          {
            label: t("settings.removeDialog.removeOnly"),
            variant: "secondary",
            onClick: () => {
              const id = removeTarget?.id;
              setRemoveTarget(null);
              if (id)
                void removeWatchedFolder(id)
                  .then(() => onReload())
                  .catch((e) => alert(String(e)));
            },
          },
          {
            label: t("settings.removeDialog.removeAndDelete"),
            variant: "destructive",
            onClick: () => {
              const id = removeTarget?.id;
              setRemoveTarget(null);
              if (!id) return;
              void (async () => {
                try {
                  await deleteFolderSnapshots(id);
                  await removeWatchedFolder(id);
                  await onReload();
                } catch (e) {
                  alert(String(e));
                }
              })();
            },
          },
        ]}
      />

      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">
          {t("settings.watchedFolders")}
        </h3>
        {cfg.watchedFolders.map((f) => (
          <div
            key={f.id}
            className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm"
          >
            <div className="font-mono text-xs text-zinc-400">{f.path}</div>
            <div className="space-y-1 text-xs text-zinc-500">
              <div>{t("settings.snapshotLocation")}</div>
              <div className="break-all font-mono text-zinc-300">
                {snapshotParentForFolder(f, cfg, systemParent)}/{f.id}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={(e) => {
                  void updateWatchedFolder(f.id, { enabled: e.target.checked }).then(
                    () => onReload(),
                  );
                }}
              />
              {t("settings.enabled")}
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                className="text-xs text-red-300"
                onClick={() =>
                  setRemoveTarget({ id: f.id, path: f.path })
                }
              >
                {t("settings.remove")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="text-xs"
                onClick={async () => {
                  try {
                    const picked = await pickDirectory();
                    if (!picked) return;
                    setPendingMove({
                      kind: "folder",
                      folderId: f.id,
                      newParent: picked,
                    });
                  } catch (e) {
                    alert(String(e));
                  }
                }}
              >
                {t("settings.changeLocation")}
              </Button>
              {f.snapshotRootOverride != null && f.snapshotRootOverride !== "" && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-xs"
                  onClick={() =>
                    setPendingMove({
                      kind: "folder",
                      folderId: f.id,
                      newParent: null,
                    })
                  }
                >
                  {t("settings.resetLocation")}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                className="text-xs"
                onClick={async () => {
                  try {
                    const p = await previewFolderMatches(f.id);
                    setPreviewById((prev) => ({
                      ...prev,
                      [f.id]: t("settings.previewResult", {
                        matched: p.matched.length,
                        ignored: p.ignored.length,
                      }),
                    }));
                  } catch (e) {
                    alert(String(e));
                  }
                }}
              >
                {t("settings.preview")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-xs"
                onClick={() => void revealPath(f.path)}
              >
                {t("settings.reveal")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-xs"
                onClick={() =>
                  void revealPath(snapshotParentForFolder(f, cfg, systemParent))
                }
              >
                {t("settings.revealSnapshotRoot")}
              </Button>
            </div>
            {previewById[f.id] && (
              <p className="text-xs text-zinc-500">{previewById[f.id]}</p>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAddFolderOpen(true)}
        >
          {t("settings.add")}
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">
          {t("settings.startup")}
        </h3>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={cfg.startAtLogin}
            onChange={(e) => {
              void setConfig({ ...cfg, startAtLogin: e.target.checked })
                .then(() => onReload())
                .catch((err) => {
                  alert(String(err));
                });
            }}
          />
          {t("settings.startAtLogin")}
        </label>
        <p className="text-xs leading-relaxed text-zinc-500">
          {t("settings.startAtLoginHint")}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">
          {t("settings.watching")}
        </h3>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void pauseWatching()}>
            {t("settings.pause")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void resumeWatching()}>
            {t("settings.resume")}
          </Button>
        </div>
        <WatcherStatus />
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">
          {t("settings.storage")}
        </h3>
        <div className="space-y-2 text-xs text-zinc-500">
          <div className="font-medium text-zinc-300">
            {t("settings.snapshotLocationDefault")}
          </div>
          <div className="break-all font-mono text-zinc-400">
            {(cfg.defaultSnapshotRoot ?? systemParent) || "—"}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="text-xs"
              onClick={async () => {
                try {
                  const picked = await pickDirectory();
                  if (!picked) return;
                  setPendingMove({ kind: "default", newParent: picked });
                } catch (e) {
                  alert(String(e));
                }
              }}
            >
              {t("settings.changeLocation")}
            </Button>
            {cfg.defaultSnapshotRoot != null &&
              cfg.defaultSnapshotRoot !== "" && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-xs"
                  onClick={() =>
                    setPendingMove({ kind: "default", newParent: null })
                  }
                >
                  {t("settings.resetLocation")}
                </Button>
              )}
            <Button
              type="button"
              variant="ghost"
              className="text-xs"
              onClick={() => {
                const p = cfg.defaultSnapshotRoot ?? systemParent;
                if (p) void revealPath(p);
              }}
            >
              {t("settings.revealSnapshotRoot")}
            </Button>
          </div>
        </div>
        <StorageBlock cfg={cfg} />
      </div>

      <div
        key={i18n.language}
        className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4"
      >
        <h3 className="text-sm font-medium text-zinc-300">
          {t("settings.language")}
        </h3>
        <div className="flex flex-col gap-2">
          {(["en", "pt-BR"] as const).map((lng) => (
            <label
              key={lng}
              className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200"
            >
              <input
                type="radio"
                name="lang"
                checked={normalizeUiLang(i18n.language) === lng}
                onChange={() => {
                  void i18n.changeLanguage(lng);
                }}
              />
              {lng === "en"
                ? t("settings.languageEnglish")
                : t("settings.languagePortuguese")}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function WatcherStatus() {
  const { t } = useTranslation();
  const [paused, setPaused] = useState<boolean | null>(null);
  useEffect(() => {
    void getStatus()
      .then((s) => setPaused(s.watchingPaused))
      .catch(() => setPaused(null));
  }, []);
  const label =
    paused === null
      ? "?"
      : paused
        ? t("settings.statusPaused")
        : t("settings.statusRunning");
  return (
    <p className="text-xs text-zinc-500">
      {t("settings.watcherStatus", { status: label })}
    </p>
  );
}

function StorageBlock({ cfg }: { cfg: Config }) {
  const { t } = useTranslation();
  const [u, setU] = useState<string>("");
  useEffect(() => {
    void getStorageUsage()
      .then((s) => setU(formatBytes(s.totalBytes)))
      .catch(() => setU("?"));
  }, [cfg]);
  return (
    <p className="text-xs text-zinc-500">
      {t("settings.totalStorage", { n: u })}
    </p>
  );
}

// ----------------------------- Help pane -----------------------------

type HelpTopic =
  | "howItWorks"
  | "restoring"
  | "pauseResume"
  | "dataLocation"
  | "troubleshooting";

const HELP_TOPICS: HelpTopic[] = [
  "howItWorks",
  "restoring",
  "pauseResume",
  "dataLocation",
  "troubleshooting",
];

function HelpPane() {
  const { t } = useTranslation();
  const [topic, setTopic] = useState<HelpTopic>("howItWorks");
  return (
    <div className="mx-auto flex max-w-4xl gap-4">
      <aside className="w-56 shrink-0 space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <h2 className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t("help.title")}
        </h2>
        {HELP_TOPICS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTopic(k)}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              topic === k
                ? "border-l-2 border-emerald-500 bg-zinc-800 pl-[6px] text-white"
                : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            {t(`help.topics.${k}`)}
          </button>
        ))}
      </aside>
      <article className="flex-1 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-6 text-sm leading-relaxed text-zinc-300">
        {topic === "howItWorks" && <HelpHowItWorks />}
        {topic === "restoring" && <HelpRestoring />}
        {topic === "pauseResume" && <HelpPauseResume />}
        {topic === "dataLocation" && <HelpDataLocation />}
        {topic === "troubleshooting" && <HelpTroubleshooting />}
      </article>
    </div>
  );
}

function HelpHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-base font-semibold text-white">{children}</h3>;
}

function HelpSubheading({ children }: { children: ReactNode }) {
  return (
    <h4 className="pt-2 text-sm font-semibold text-zinc-100">{children}</h4>
  );
}

function HelpCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100">
      {children}
    </code>
  );
}

function HelpHowItWorks() {
  const { t } = useTranslation();
  return (
    <>
      <HelpHeading>{t("help.howItWorks.title")}</HelpHeading>
      <p>{t("help.howItWorks.intro")}</p>
      <HelpSubheading>{t("help.howItWorks.snapshotTitle")}</HelpSubheading>
      <p>{t("help.howItWorks.snapshot")}</p>
      <HelpSubheading>{t("help.howItWorks.debounceTitle")}</HelpSubheading>
      <p>{t("help.howItWorks.debounce")}</p>
      <HelpSubheading>{t("help.howItWorks.dedupTitle")}</HelpSubheading>
      <p>{t("help.howItWorks.dedup")}</p>
    </>
  );
}

function HelpRestoring() {
  const { t } = useTranslation();
  return (
    <>
      <HelpHeading>{t("help.restoring.title")}</HelpHeading>
      <p>{t("help.restoring.intro")}</p>
      <ol className="list-decimal space-y-1 pl-5 text-zinc-200">
        <li>{t("help.restoring.step1")}</li>
        <li>{t("help.restoring.step2")}</li>
        <li>{t("help.restoring.step3")}</li>
      </ol>
      <HelpSubheading>{t("help.restoring.safetyTitle")}</HelpSubheading>
      <p>{t("help.restoring.safety")}</p>
      <HelpSubheading>{t("help.restoring.wordTitle")}</HelpSubheading>
      <p>{t("help.restoring.word")}</p>
    </>
  );
}

function HelpPauseResume() {
  const { t } = useTranslation();
  return (
    <>
      <HelpHeading>{t("help.pauseResume.title")}</HelpHeading>
      <p>{t("help.pauseResume.intro")}</p>
      <p>{t("help.pauseResume.where")}</p>
      <ul className="list-disc space-y-1 pl-5 text-zinc-200">
        <li>{t("help.pauseResume.tray")}</li>
        <li>{t("help.pauseResume.settings")}</li>
      </ul>
      <HelpSubheading>{t("help.pauseResume.behaviorTitle")}</HelpSubheading>
      <p>{t("help.pauseResume.behavior")}</p>
    </>
  );
}

function HelpDataLocation() {
  const { t } = useTranslation();
  return (
    <>
      <HelpHeading>{t("help.dataLocation.title")}</HelpHeading>
      <p>{t("help.dataLocation.intro")}</p>
      <HelpSubheading>{t("help.dataLocation.configTitle")}</HelpSubheading>
      <p>
        {t("help.dataLocation.config").replace(
          "~/Library/Application Support/AutoVersion/config.json",
          "",
        )}
        <HelpCode>~/Library/Application Support/AutoVersion/config.json</HelpCode>
      </p>
      <HelpSubheading>{t("help.dataLocation.snapshotsTitle")}</HelpSubheading>
      <p>{t("help.dataLocation.snapshots")}</p>
      <HelpSubheading>{t("help.dataLocation.logsTitle")}</HelpSubheading>
      <p>{t("help.dataLocation.logs")}</p>
      <HelpSubheading>{t("help.dataLocation.nukeTitle")}</HelpSubheading>
      <p>{t("help.dataLocation.nuke")}</p>
    </>
  );
}

function HelpTroubleshooting() {
  const { t } = useTranslation();
  return (
    <>
      <HelpHeading>{t("help.troubleshooting.title")}</HelpHeading>
      <HelpSubheading>{t("help.troubleshooting.noSnapshotsTitle")}</HelpSubheading>
      <p>{t("help.troubleshooting.noSnapshots")}</p>
      <HelpSubheading>{t("help.troubleshooting.manyVersionsTitle")}</HelpSubheading>
      <p>{t("help.troubleshooting.manyVersions")}</p>
      <HelpSubheading>{t("help.troubleshooting.gatekeeperTitle")}</HelpSubheading>
      <p>{t("help.troubleshooting.gatekeeper")}</p>
    </>
  );
}

export default App;
