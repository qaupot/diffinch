import { useState } from "react";
import { useTranslation } from "../i18n";
import { readEditor, saveEditor } from "../lib/external-tools";
import GitModal from "./GitModal";

const editors = { code: "Visual Studio Code", cursor: "Cursor", zed: "Zed", subl: "Sublime Text" };
export default function ExternalTools({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState(readEditor);
  const [preset, setPreset] = useState(() =>
    Object.hasOwn(editors, editor.program) ? editor.program : "custom",
  );
  const [args, setArgs] = useState(editor.args.join("\n"));
  return (
    <GitModal title={t("externalTools")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          saveEditor({
            program: editor.program.trim(),
            args: args.split("\n").filter((arg) => arg.length > 0),
          });
          onClose();
        }}
      >
        <label>
          {t("preferredEditor")}
          <select
            value={preset}
            onChange={(event) => {
              const value = event.target.value;
              setPreset(value);
              if (value !== "custom") {
                setEditor({ program: value, args: [] });
                setArgs("");
              }
            }}
          >
            {Object.entries(editors).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
            <option value="custom">{t("customEditor")}</option>
          </select>
        </label>
        {preset === "custom" && (
          <label>
            {t("editorProgram")}
            <input
              required
              value={editor.program}
              onChange={(event) => setEditor({ ...editor, program: event.target.value })}
            />
          </label>
        )}
        <label>
          {t("editorArguments")}
          <textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} />
        </label>
        <p className="muted">{t("editorArgumentsHelp")}</p>
        <p>{t("mergeToolHelp")}</p>
        <div className="modal-actions">
          <button type="button" className="plain-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={!editor.program.trim()}>
            {t("saveSettings")}
          </button>
        </div>
      </form>
    </GitModal>
  );
}
