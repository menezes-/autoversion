import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ConfigChangedPayload {
  // empty
}

export interface SnapshotCreatedPayload {
  folderId: string;
  relativePath: string;
  commitSha: string;
  timestamp: string;
}

export interface WatcherErrorPayload {
  folderId: string;
  message: string;
}

export interface RestoreCompletedPayload {
  folderId: string;
  relativePath: string;
  restoredFromSha: string;
}

export function onConfigChanged(
  handler: (payload: ConfigChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<ConfigChangedPayload>("config-changed", (e) => {
    handler(e.payload);
  });
}

export function onSnapshotCreated(
  handler: (payload: SnapshotCreatedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SnapshotCreatedPayload>("snapshot-created", (e) => {
    handler(e.payload);
  });
}

export function onWatcherError(
  handler: (payload: WatcherErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<WatcherErrorPayload>("watcher-error", (e) => {
    handler(e.payload);
  });
}

export function onRestoreCompleted(
  handler: (payload: RestoreCompletedPayload) => void,
): Promise<UnlistenFn> {
  return listen<RestoreCompletedPayload>("restore-completed", (e) => {
    handler(e.payload);
  });
}
