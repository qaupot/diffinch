import { useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "../i18n";
import { X } from "../icons";
import OperationProgress from "../workspace/OperationProgress";

export default function GitModal({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="modal-title">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" title={t("close")} onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      {children}
      <OperationProgress />
    </dialog>
  );
}
