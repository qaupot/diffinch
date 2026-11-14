import type { Theme } from "./types";

export function readTheme(value: string | null): Theme {
  return value === "white" || value === "dark" ? value : "blue";
}
