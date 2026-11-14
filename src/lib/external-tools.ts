import type { EditorCommand } from "./git";
import { preferences } from "./preferences";

const key = "diffinch.editor";
export function readEditor(): EditorCommand {
  try {
    const saved: unknown = JSON.parse(preferences.getItem(key) ?? "null");
    if (
      saved &&
      typeof saved === "object" &&
      "program" in saved &&
      typeof saved.program === "string" &&
      "args" in saved &&
      Array.isArray(saved.args) &&
      saved.args.every((arg) => typeof arg === "string")
    )
      return { program: saved.program, args: saved.args };
  } catch {
    /* Use the default until an editor is selected. */
  }
  return { program: "code", args: [] };
}
export function saveEditor(editor: EditorCommand) {
  preferences.setItem(key, JSON.stringify(editor));
}
