//! Built-in format registry (see `ARCHITECTURE.md`). Single source of truth for
//! ignore patterns used by the watcher and `diff_kind` metadata for the UI mirror.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Text,
    Docx,
    OpaqueBinary,
}

pub struct FormatHandler {
    pub extensions: &'static [&'static str],
    pub ignore_patterns: &'static [&'static str],
    /// Used by the frontend mirror / diff dispatch (not referenced from Rust watcher code).
    #[allow(dead_code)]
    pub diff_kind: DiffKind,
    #[allow(dead_code)]
    pub display_name: &'static str,
}

/// Handlers are checked in order; the last entry is the catch-all.
pub static HANDLERS: &[FormatHandler] = &[
    FormatHandler {
        extensions: &["docx"],
        ignore_patterns: &["~$*.docx", ".~lock.*.docx#", "*.docx.tmp"],
        diff_kind: DiffKind::Docx,
        display_name: "Microsoft Word",
    },
    FormatHandler {
        extensions: &["md", "markdown"],
        ignore_patterns: &["*.md.swp", "*.md~"],
        diff_kind: DiffKind::Text,
        display_name: "Markdown",
    },
    FormatHandler {
        extensions: &["txt"],
        ignore_patterns: &["*.txt.swp", "*.txt~"],
        diff_kind: DiffKind::Text,
        display_name: "Plain text",
    },
    FormatHandler {
        extensions: &["tex"],
        ignore_patterns: &[
            "*.aux",
            "*.log",
            "*.synctex.gz",
            "*.toc",
            "*.out",
            "*.bbl",
            "*.blg",
            "*.fls",
            "*.fdb_latexmk",
        ],
        diff_kind: DiffKind::Text,
        display_name: "LaTeX",
    },
    FormatHandler {
        extensions: &[
            "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cc", "cpp",
            "cxx", "h", "hh", "hpp", "rb", "cs", "kt", "swift", "php", "scala", "sh", "bash",
            "zsh", "fish", "sql", "r", "lua", "vim", "el",
        ],
        ignore_patterns: &["*.swp", "*.swo", "*~", ".#*", "*.orig"],
        diff_kind: DiffKind::Text,
        display_name: "Source code",
    },
    FormatHandler {
        extensions: &[],
        ignore_patterns: &[],
        diff_kind: DiffKind::OpaqueBinary,
        display_name: "Other",
    },
];

/// Patterns applied to every watched path regardless of extension.
pub fn universal_ignore_patterns() -> &'static [&'static str] {
    &[
        ".DS_Store",
        "Thumbs.db",
        "desktop.ini",
        ".~lock.*",
        "**/.git/**",
        "**/.svn/**",
        "**/.hg/**",
        "*~",
        "**/.*.swp",
        "**/.*.swo",
        "**/.*.swn",
    ]
}

/// Normalized extension without leading dot, lowercase.
pub fn normalize_extension(ext: &str) -> String {
    ext.trim().trim_start_matches('.').to_lowercase()
}

/// Returns the best matching handler; the last entry is the catch-all.
pub fn find_handler(extension: &str) -> &'static FormatHandler {
    let e = normalize_extension(extension);
    for h in HANDLERS.iter().take(HANDLERS.len().saturating_sub(1)) {
        if h.extensions.iter().copied().any(|x| x == e.as_str()) {
            return h;
        }
    }
    HANDLERS.last().expect("catch-all handler")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_maps_to_docx_kind() {
        let h = find_handler("docx");
        assert_eq!(h.diff_kind, DiffKind::Docx);
        assert!(h.ignore_patterns.contains(&"~$*.docx"));
    }

    #[test]
    fn unknown_ext_is_opaque() {
        let h = find_handler("xyz");
        assert_eq!(h.diff_kind, DiffKind::OpaqueBinary);
        assert_eq!(h.display_name, "Other");
    }

    #[test]
    fn markdown_normalizes() {
        let h = find_handler(".Markdown");
        assert_eq!(h.diff_kind, DiffKind::Text);
    }
}
