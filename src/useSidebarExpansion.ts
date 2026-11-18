import { useState } from "react";
import { preferences } from "./lib/preferences";

function readExpansion(storageKey: string): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(preferences.getItem(storageKey) ?? "null");
    if (Array.isArray(saved)) {
      // Earlier versions stored only the names of collapsed branch groups.
      return Object.fromEntries(
        saved.filter((key): key is string => typeof key === "string").map((key) => [key, false]),
      );
    }
    if (saved && typeof saved === "object") {
      return Object.fromEntries(
        Object.entries(saved).filter(([, value]) => typeof value === "boolean"),
      );
    }
  } catch {
    // Fall back to the sidebar defaults if the saved value is unreadable.
  }
  return {};
}

export function useSidebarExpansion(storageKey: string) {
  const [choices, setChoices] = useState(() => readExpansion(storageKey));

  function isExpanded(key: string) {
    return choices[key] ?? (key === "local" || key === "remote");
  }

  function toggle(key: string) {
    const next = { ...choices, [key]: !isExpanded(key) };
    setChoices(next);
    preferences.setItem(storageKey, JSON.stringify(next));
  }

  return { isExpanded, toggle };
}
