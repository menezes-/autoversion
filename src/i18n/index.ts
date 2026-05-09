import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";

export const SUPPORTED_LANGUAGES = ["en", "pt-BR"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      // Register the pt-BR bundle under both `pt-BR` and `pt`. i18next's default
      // fallback chain for a `pt-BR` locale is `["pt-BR", "pt", "en"]`; without
      // a `pt` entry, region-stripped lookups silently fall through to English.
      "pt-BR": { translation: ptBR },
      pt: { translation: ptBR },
    },
    fallbackLng: "en",
    supportedLngs: ["en", "pt", "pt-BR"],
    // Use the exact resolved code; do NOT strip the region.
    load: "currentOnly",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "autoversion.lang",
      caches: ["localStorage"],
    },
    returnNull: false,
    // Without this, React often fails to re-render when `changeLanguage` runs
    // because there is no <Suspense> boundary around the tree (Tauri + Vite).
    react: { useSuspense: false },
  });

i18n.on("languageChanged", (lng) => {
  try {
    localStorage.setItem("autoversion.lang", lng);
  } catch {
    /* private mode / denied */
  }
});

i18n.on("failedLoading", (lng, ns, msg) => {
  console.warn("[i18n] failedLoading", lng, ns, msg);
});

// Expose for ad-hoc DevTools inspection: `window.__i18n.changeLanguage('pt-BR')`.
declare global {
  interface Window {
    __i18n?: typeof i18n;
  }
}
window.__i18n = i18n;

export default i18n;
