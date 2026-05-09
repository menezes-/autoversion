import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import * as Diff from "diff";
import { formatDistanceToNow, parseISO } from "date-fns";
import mammoth from "mammoth";
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
  listSnapshots,
  listWatchedFiles,
  pauseWatching,
  previewFolderMatches,
  removeWatchedFolder,
  restoreSnapshot,
  resumeWatching,
  revealPath,
  runRetentionNow,
  setConfig,
  updateWatchedFolder,
  type Config,
  type FileEntry,
  type Snapshot,
} from "@/lib/tauri";

type Nav = "folders" | "settings" | "about";
type CompareMode = "previous" | "current" | "pick";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
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

  const [settingsPreview, setSettingsPreview] = useState<string>("");
  const [extInput, setExtInput] = useState("");

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
      setToast(`Restored from ${p.restoredFromSha.slice(0, 7)}`);
      setTimeout(() => setToast(null), 4000);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [refresh, selectedFile, selectedFolderId]);

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
      return;
    }
    void listSnapshots(selectedFolderId, selectedFile)
      .then(setSnaps)
      .catch((e) => setErr(String(e)));
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

  const renderDiff = () => {
    if (!selectedSnap || !selectedFile) {
      return (
        <p className="text-sm text-zinc-500">Select a file and a snapshot.</p>
      );
    }
    const left = bytesToUtf8(leftBytes);
    const right = bytesToUtf8(rightBytes);
    if (diffKind === "opaqueBinary") {
      return (
        <div className="space-y-2 text-sm text-zinc-300">
          <p>Metadata-only (opaque binary)</p>
          <p>Left length: {leftBytes.length} bytes</p>
          <p>Right length: {rightBytes.length} bytes</p>
        </div>
      );
    }
    if (diffKind === "docx") {
      return <DocxDiff left={leftBytes} right={rightBytes} />;
    }
    if (left === right && snaps.length <= 1) {
      return (
        <pre className="max-h-[480px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
          {right}
        </pre>
      );
    }
    const parts = Diff.diffLines(left, right);
    return (
      <pre className="max-h-[480px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs">
        {parts.map((p, i) => (
          <span
            key={i}
            className={
              p.added
                ? "bg-emerald-900/40 text-emerald-100"
                : p.removed
                  ? "bg-red-900/40 text-red-100"
                  : "text-zinc-300"
            }
          >
            {p.value}
          </span>
        ))}
      </pre>
    );
  };

  if (!cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  if (cfg.watchedFolders.length === 0) {
    return (
      <Onboarding
        cfg={cfg}
        onDone={() => {
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {toast && (
        <div className="border-b border-emerald-900/40 bg-emerald-950/50 px-4 py-2 text-sm text-emerald-100">
          {toast}
        </div>
      )}
      {err && (
        <div className="border-b border-red-900/40 bg-red-950/40 px-4 py-2 text-sm text-red-100">
          {err}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-48 flex-col border-r border-zinc-800 bg-zinc-900/50">
          <div className="border-b border-zinc-800 p-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            AutoVersion
          </div>
          {(["folders", "settings", "about"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setNav(k)}
              className={`px-3 py-2 text-left text-sm capitalize ${
                nav === k ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/60"
              }`}
            >
              {k}
            </button>
          ))}
        </aside>
        <main className="flex-1 overflow-auto p-4">
          {nav === "folders" && (
            <FoldersPane
              cfg={cfg}
              selectedFolderId={selectedFolderId}
              setSelectedFolderId={setSelectedFolderId}
              files={files}
              selectedFile={selectedFile}
              setSelectedFile={setSelectedFile}
              snaps={snaps}
              selectedSnap={selectedSnap}
              setSelectedSnap={setSelectedSnap}
              compare={compare}
              setCompare={setCompare}
              comparePickSha={comparePickSha}
              setComparePickSha={setComparePickSha}
              renderDiff={renderDiff}
              onRestore={async () => {
                if (!selectedFolderId || !selectedFile || !selectedSnap) return;
                const ext = selectedFile.split(".").pop()?.toLowerCase() ?? "";
                const warn =
                  ext === "docx"
                    ? "\n\nIf the file is open in Word, close it before restoring."
                    : "";
                if (
                  !confirm(
                    `Replace ${selectedFile} with this version? Current file will be snapshotted first.${warn}`,
                  )
                ) {
                  return;
                }
                try {
                  await restoreSnapshot(
                    selectedFolderId,
                    selectedSnap.commitSha,
                    selectedFile,
                  );
                } catch (e) {
                  setErr(String(e));
                }
              }}
            />
          )}
          {nav === "settings" && (
            <SettingsPane
              cfg={cfg}
              extInput={extInput}
              setExtInput={setExtInput}
              settingsPreview={settingsPreview}
              setSettingsPreview={setSettingsPreview}
              onReload={refresh}
            />
          )}
          {nav === "about" && (
            <div className="max-w-lg space-y-2 text-sm text-zinc-300">
              <h2 className="text-lg font-semibold text-white">About</h2>
              <p>
                AutoVersion keeps automatic snapshots of files in folders you
                choose. Snapshots live under{" "}
                <code className="rounded bg-zinc-800 px-1">
                  ~/Library/Application Support/AutoVersion/repos/
                </code>
                .
              </p>
              <p className="text-zinc-500">
                Unsigned macOS build: first open with right-click → Open, or{" "}
                <code className="rounded bg-zinc-800 px-1">
                  xattr -cr /Applications/AutoVersion.app
                </code>
                .
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function DocxDiff({ left, right }: { left: number[]; right: number[] }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lb = Uint8Array.from(left);
      const rb = Uint8Array.from(right);
      const lbuf = lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength);
      const rbuf = rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.byteLength);
      const l = await mammoth.extractRawText({ arrayBuffer: lbuf });
      const r = await mammoth.extractRawText({ arrayBuffer: rbuf });
      if (!cancelled) {
        setA(l.value);
        setB(r.value);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [left, right]);
  const parts = Diff.diffWordsWithSpace(a, b);
  return (
    <div className="max-h-[480px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm leading-relaxed">
      {parts.map((p, i) => (
        <span
          key={i}
          className={
            p.added
              ? "bg-emerald-900/40 text-emerald-100"
              : p.removed
                ? "bg-red-900/40 text-red-100"
                : "text-zinc-200"
          }
        >
          {p.value}
        </span>
      ))}
    </div>
  );
}

function Onboarding({
  cfg,
  onDone,
}: {
  cfg: Config;
  onDone: () => void;
}) {
  const [ext, setExt] = useState("docx, md");
  const [login, setLogin] = useState(cfg.startAtLogin);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 p-10">
      <h1 className="text-2xl font-semibold text-white">
        AutoVersion keeps a history of every save, so nothing ever gets lost.
      </h1>
      <Button
        type="button"
        onClick={async () => {
          const dir = await open({ directory: true, multiple: false });
          if (typeof dir !== "string" || !dir) return;
          const parts = ext
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          try {
            await addWatchedFolder(dir, parts);
            const next = { ...cfg, startAtLogin: login };
            await setConfig(next);
            await sendNotification({
              title: "AutoVersion",
              body: `Now protecting ${dir.split("/").pop() ?? dir}`,
            });
            onDone();
          } catch (e) {
            alert(String(e));
          }
        }}
      >
        Pick a folder to protect
      </Button>
      <label className="text-sm text-zinc-400">
        Extensions (comma-separated, no dots)
        <input
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100"
          value={ext}
          onChange={(e) => setExt(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={login}
          onChange={(e) => setLogin(e.target.checked)}
        />
        Start AutoVersion automatically when I log in
      </label>
    </div>
  );
}

function FoldersPane({
  cfg,
  selectedFolderId,
  setSelectedFolderId,
  files,
  selectedFile,
  setSelectedFile,
  snaps,
  selectedSnap,
  setSelectedSnap,
  compare,
  setCompare,
  comparePickSha,
  setComparePickSha,
  renderDiff,
  onRestore,
}: {
  cfg: Config;
  selectedFolderId: string | null;
  setSelectedFolderId: (id: string | null) => void;
  files: FileEntry[];
  selectedFile: string | null;
  setSelectedFile: (p: string | null) => void;
  snaps: Snapshot[];
  selectedSnap: Snapshot | null;
  setSelectedSnap: (s: Snapshot | null) => void;
  compare: CompareMode;
  setCompare: (c: CompareMode) => void;
  comparePickSha: string | null;
  setComparePickSha: (s: string | null) => void;
  renderDiff: () => ReactNode;
  onRestore: () => Promise<void>;
}) {
  return (
    <div className="grid h-full min-h-[560px] grid-cols-12 gap-3">
      <section className="col-span-3 space-y-2 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <h3 className="px-1 text-xs font-semibold uppercase text-zinc-500">
          Folders
        </h3>
        {cfg.watchedFolders.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              setSelectedFolderId(f.id);
              setSelectedFile(null);
              setSelectedSnap(null);
            }}
            className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm ${
              selectedFolderId === f.id
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            {f.path}
          </button>
        ))}
      </section>
      <section className="col-span-3 space-y-2 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <h3 className="px-1 text-xs font-semibold uppercase text-zinc-500">
          Files
        </h3>
        {files.length === 0 && (
          <p className="px-1 text-xs text-zinc-500">No saves yet.</p>
        )}
        {files.map((f) => (
          <button
            key={f.relativePath}
            type="button"
            onClick={() => {
              setSelectedFile(f.relativePath);
              setSelectedSnap(null);
            }}
            className={`block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs ${
              selectedFile === f.relativePath
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            {f.relativePath}
          </button>
        ))}
      </section>
      <section className="col-span-6 flex flex-col gap-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
            value={compare}
            onChange={(e) => setCompare(e.target.value as CompareMode)}
          >
            <option value="previous">Previous version</option>
            <option value="current">Current file on disk</option>
            <option value="pick">Pick another version…</option>
          </select>
          {compare === "pick" && (
            <select
              className="max-w-[200px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
              value={comparePickSha ?? ""}
              onChange={(e) => setComparePickSha(e.target.value || null)}
            >
              <option value="">Select commit</option>
              {snaps.map((s) => (
                <option key={s.commitSha} value={s.commitSha}>
                  {s.commitSha.slice(0, 7)} —{" "}
                  {formatDistanceToNow(parseISO(s.timestamp), {
                    addSuffix: true,
                  })}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            variant="secondary"
            className="ml-auto text-xs"
            disabled={!selectedSnap}
            onClick={() => void onRestore()}
          >
            Restore this version
          </Button>
        </div>
        <div className="max-h-40 overflow-auto rounded border border-zinc-800">
          {snaps.map((s) => (
            <button
              key={s.commitSha}
              type="button"
              onClick={() => setSelectedSnap(s)}
              className={`block w-full border-b border-zinc-800 px-2 py-1.5 text-left text-xs last:border-0 ${
                selectedSnap?.commitSha === s.commitSha
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/40"
              }`}
            >
              {formatDistanceToNow(parseISO(s.timestamp), { addSuffix: true })}{" "}
              <span className="font-mono text-zinc-500">{s.commitSha.slice(0, 7)}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{renderDiff()}</div>
      </section>
    </div>
  );
}

function SettingsPane({
  cfg,
  extInput,
  setExtInput,
  settingsPreview,
  setSettingsPreview,
  onReload,
}: {
  cfg: Config;
  extInput: string;
  setExtInput: (s: string) => void;
  settingsPreview: string;
  setSettingsPreview: (s: string) => void;
  onReload: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h2 className="text-lg font-semibold text-white">Settings</h2>
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">Watched folders</h3>
        {cfg.watchedFolders.map((f) => (
          <div
            key={f.id}
            className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm"
          >
            <div className="font-mono text-xs text-zinc-400">{f.path}</div>
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
              Enabled
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                className="text-xs text-red-300"
                onClick={() => void removeWatchedFolder(f.id).then(() => onReload())}
              >
                Remove
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="text-xs"
                onClick={async () => {
                  try {
                    const p = await previewFolderMatches(f.id);
                    setSettingsPreview(
                      `${p.matched.length} matched, ${p.ignored.length} ignored`,
                    );
                  } catch (e) {
                    alert(String(e));
                  }
                }}
              >
                Preview matches
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-xs"
                onClick={() => void revealPath(f.path)}
              >
                Reveal in Finder
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            const dir = await open({ directory: true, multiple: false });
            if (typeof dir !== "string" || !dir) return;
            const exts = extInput
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            try {
              await addWatchedFolder(dir, exts.length ? exts : ["md", "docx"]);
              await onReload();
            } catch (e) {
              alert(String(e));
            }
          }}
        >
          Add folder
        </Button>
        <input
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200"
          placeholder="extensions for new folder (comma-separated)"
          value={extInput}
          onChange={(e) => setExtInput(e.target.value)}
        />
        {settingsPreview && (
          <p className="text-xs text-zinc-500">{settingsPreview}</p>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">Watching</h3>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void pauseWatching()}>
            Pause
          </Button>
          <Button type="button" variant="secondary" onClick={() => void resumeWatching()}>
            Resume
          </Button>
        </div>
        <WatcherStatus />
      </div>
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
        <h3 className="text-sm font-medium text-zinc-300">Storage</h3>
        <StorageBlock />
        <Button type="button" variant="ghost" className="text-xs" onClick={() => void runRetentionNow()}>
          Run retention now (v1 no-op)
        </Button>
      </div>
    </div>
  );
}

function WatcherStatus() {
  const [st, setSt] = useState<string>("");
  useEffect(() => {
    void getStatus()
      .then((s) =>
        setSt(
          s.watchingPaused ? "Paused" : "Running",
        ),
      )
      .catch(() => setSt("?"));
  }, []);
  return <p className="text-xs text-zinc-500">Watcher: {st}</p>;
}

function StorageBlock() {
  const [u, setU] = useState<string>("");
  useEffect(() => {
    void getStorageUsage()
      .then((s) => setU(formatBytes(s.totalBytes)))
      .catch(() => setU("?"));
  }, []);
  return <p className="text-xs text-zinc-500">Total snapshot storage: {u}</p>;
}

export default App;
