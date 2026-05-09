/**
 * Frontend mirror of `src-tauri/src/formats.rs` — diff dispatch only.
 * Do not duplicate ignore logic here; the watcher enforces patterns in Rust.
 */

export type DiffKind = "text" | "docx" | "opaqueBinary";

export interface FormatEntry {
  extensions: string[];
  diffKind: DiffKind;
  displayName: string;
}

/** Order matches Rust `HANDLERS` (specific → catch-all last). */
export const FORMAT_HANDLERS: FormatEntry[] = [
  {
    extensions: ["docx"],
    diffKind: "docx",
    displayName: "Microsoft Word",
  },
  {
    extensions: ["md", "markdown"],
    diffKind: "text",
    displayName: "Markdown",
  },
  {
    extensions: ["txt"],
    diffKind: "text",
    displayName: "Plain text",
  },
  {
    extensions: ["tex"],
    diffKind: "text",
    displayName: "LaTeX",
  },
  {
    extensions: [
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
    diffKind: "text",
    displayName: "Source code",
  },
  {
    extensions: [],
    diffKind: "opaqueBinary",
    displayName: "Other",
  },
];

export function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\./, "").toLowerCase();
}

export function findFormatEntry(extension: string): FormatEntry {
  const e = normalizeExtension(extension);
  const specific = FORMAT_HANDLERS.slice(0, -1);
  for (const h of specific) {
    if (h.extensions.includes(e)) {
      return h;
    }
  }
  return FORMAT_HANDLERS[FORMAT_HANDLERS.length - 1]!;
}
