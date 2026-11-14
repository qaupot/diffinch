import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation, type LocalizedMessage } from "./i18n";
import { Check, CircleAlert, X } from "./icons";

export default function Notice({
  message,
  error,
  onDismiss,
  autoDismiss = false,
}: {
  message: LocalizedMessage;
  error: boolean;
  onDismiss: () => void;
  autoDismiss?: boolean;
}) {
  const { t } = useTranslation();
  const notice = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expire = useEffectEvent(() => {
    if (!notice.current?.contains(document.activeElement)) onDismiss();
  });
  useEffect(() => {
    if (!autoDismiss || error || focused || hovered) return;
    const timer = window.setTimeout(expire, 3500);
    return () => window.clearTimeout(timer);
  }, [message, error, autoDismiss, focused, hovered]);
  return (
    <div
      ref={notice}
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          previousFocus.current = event.relatedTarget as HTMLElement | null;
        setFocused(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {error ? <CircleAlert size={19} /> : <Check size={19} />}
      <span>{t(message.key, message.values)}</span>
      <button
        className="icon-button"
        aria-label={t("dismiss")}
        title={t("dismiss")}
        onClick={() => {
          if (
            notice.current?.contains(document.activeElement) &&
            previousFocus.current?.isConnected
          )
            previousFocus.current.focus();
          onDismiss();
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
