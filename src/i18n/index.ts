import { createContext, useContext } from "react";
import { preferences } from "../lib/preferences";
import { messages, type Locale, type MessageKey } from "./messages";

type Values = Record<string, string | number>;
export type LocalizedMessage = { key: MessageKey; values?: Values };

export const localeKey = "diffinch.language";

function supportedLocale(language: string): Locale | undefined {
  const base = language.toLowerCase().split("-")[0];
  return base === "en" || base === "ko" || base === "ja" ? base : undefined;
}

export function readLocale(): Locale {
  const saved = supportedLocale(preferences.getItem(localeKey) ?? "");
  return (
    saved ?? navigator.languages.map(supportedLocale).find((locale) => locale !== undefined) ?? "en"
  );
}

const localeIndex: Record<Locale, number> = { en: 0, ko: 1, ja: 2 };

function formatDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  const day = `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time}`;
}

function formatLocale(locale: Locale) {
  const number = new Intl.NumberFormat(locale);
  return {
    t(key: MessageKey, values?: Values) {
      return messages[key][localeIndex[locale]].replace(/\{(\w+)\}/g, (token, name: string) => {
        const value = values?.[name];
        return typeof value === "number" ? number.format(value) : (value ?? token);
      });
    },
    dateTime: formatDateTime,
  };
}

const formats = { en: formatLocale("en"), ko: formatLocale("ko"), ja: formatLocale("ja") };

export const LocaleContext = createContext<Locale>("en");
export const useTranslation = () => formats[useContext(LocaleContext)];

export function errorMessage(error: unknown): LocalizedMessage {
  if (
    error &&
    typeof error === "object" &&
    "key" in error &&
    typeof error.key === "string" &&
    Object.hasOwn(messages, error.key)
  ) {
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    return { key: error.key as MessageKey, values: { detail } };
  }
  return {
    key: "gitOutput",
    values: { detail: error instanceof Error ? error.message : String(error) },
  };
}
