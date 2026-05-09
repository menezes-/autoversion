import { invoke } from "@tauri-apps/api/core";

/** Mirrors `RetentionPolicy` in Rust (`serde(rename_all = "camelCase")`). */
export type RetentionPolicy =
  | "keepEverything"
  | "thinAfter7Days"
  | "thinAfter30Days"
  | "custom";

export interface WatchedFolder {
  id: string;
  path: string;
  extensions: string[];
  userIgnorePatterns: string[];
  enabled: boolean;
}

export interface Config {
  watchedFolders: WatchedFolder[];
  startAtLogin: boolean;
  retentionPolicy: RetentionPolicy;
  watchingPaused: boolean;
}

export interface WatchedFolderPatch {
  path?: string;
  extensions?: string[];
  userIgnorePatterns?: string[];
  enabled?: boolean;
}

export interface AppError {
  kind: string;
  message: string;
}

export interface FileEntry {
  relativePath: string;
}

export interface Snapshot {
  commitSha: string;
  timestamp: string;
}

export interface IgnoredPath {
  path: string;
  reason: string;
}

export interface FolderMatchPreview {
  matched: string[];
  ignored: IgnoredPath[];
}

export interface Status {
  watchingPaused: boolean;
  watchedFolderCount: number;
}

export interface FolderStorage {
  folderId: string;
  bytes: number;
}

export interface StorageUsage {
  totalBytes: number;
  perFolder: FolderStorage[];
}

export async function getConfig(): Promise<Config> {
  return invoke<Config>("get_config");
}

export async function setConfig(config: Config): Promise<void> {
  return invoke<void>("set_config", { config });
}

export async function addWatchedFolder(
  path: string,
  extensions: string[],
): Promise<WatchedFolder> {
  return invoke<WatchedFolder>("add_watched_folder", { path, extensions });
}

export async function updateWatchedFolder(
  id: string,
  patch: WatchedFolderPatch,
): Promise<WatchedFolder> {
  return invoke<WatchedFolder>("update_watched_folder", { id, patch });
}

export async function removeWatchedFolder(id: string): Promise<void> {
  return invoke<void>("remove_watched_folder", { id });
}

export async function previewFolderMatches(
  id: string,
): Promise<FolderMatchPreview> {
  return invoke<FolderMatchPreview>("preview_folder_matches", { id });
}

export async function listWatchedFiles(folderId: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_watched_files", { folderId });
}

export async function listSnapshots(
  folderId: string,
  relativePath: string,
): Promise<Snapshot[]> {
  return invoke<Snapshot[]>("list_snapshots", { folderId, relativePath });
}

export async function getSnapshotContent(
  folderId: string,
  commitSha: string,
  relativePath: string,
): Promise<number[]> {
  return invoke<number[]>("get_snapshot_content", {
    folderId,
    commitSha,
    relativePath,
  });
}

export async function getCurrentContent(
  folderId: string,
  relativePath: string,
): Promise<number[]> {
  return invoke<number[]>("get_current_content", { folderId, relativePath });
}

export async function restoreSnapshot(
  folderId: string,
  commitSha: string,
  relativePath: string,
): Promise<void> {
  return invoke<void>("restore_snapshot", {
    folderId,
    commitSha,
    relativePath,
  });
}

export async function triggerManualSnapshot(
  folderId: string,
  relativePath: string,
): Promise<void> {
  return invoke<void>("trigger_manual_snapshot", { folderId, relativePath });
}

export async function pauseWatching(): Promise<void> {
  return invoke<void>("pause_watching");
}

export async function resumeWatching(): Promise<void> {
  return invoke<void>("resume_watching");
}

export async function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

export async function getStatus(): Promise<Status> {
  return invoke<Status>("get_status");
}

export async function getStorageUsage(): Promise<StorageUsage> {
  return invoke<StorageUsage>("get_storage_usage");
}

export async function runRetentionNow(): Promise<void> {
  return invoke<void>("run_retention_now");
}

export function bytesToUtf8(bytes: number[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(u8);
}
