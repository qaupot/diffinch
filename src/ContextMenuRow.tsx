import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "./icons";

export default function ContextMenuRow({
  children,
  className,
  style,
  disabled,
  actionLabel,
  onAction,
}: {
  children: ReactNode;
  className: string;
  style?: CSSProperties;
  disabled: boolean;
  actionLabel: string;
  onAction?: () => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const available = !!onAction && !disabled;

  function close(restore = false) {
    setPosition(null);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }

  const closeFromEffect = useEffectEvent(close);

  useLayoutEffect(() => {
    if (!position) return;
    if (!available) {
      closeFromEffect();
      return;
    }
    const node = panel.current!;
    const point = position;
    function place() {
      const box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(point.x, innerWidth - box.width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(point.y, innerHeight - box.height - 8))}px`;
    }
    place();
    node.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    function outside(event: Event) {
      if (!node.contains(event.target as Node)) closeFromEffect();
    }
    function resize() {
      closeFromEffect(true);
    }
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener("resize", resize);
    document.addEventListener("scroll", outside, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [position, available]);

  function open(row: HTMLElement, target: EventTarget, point?: { x: number; y: number }) {
    if (!available) return;
    trigger.current =
      (target as HTMLElement).closest<HTMLElement>("button") ?? row.querySelector("button");
    const rect = (trigger.current ?? row).getBoundingClientRect();
    setPosition(point ?? { x: rect.left, y: rect.bottom });
  }

  return (
    <div
      className={className}
      style={style}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open(
          event.currentTarget,
          event.target,
          event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined,
        );
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        event.stopPropagation();
        open(event.currentTarget, event.target);
      }}
    >
      {children}
      {position &&
        !disabled &&
        onAction &&
        createPortal(
          <div
            ref={panel}
            className="dropdown popup-menu row-context-menu"
            role="menu"
            aria-label={actionLabel}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape" || event.key === "Tab") {
                if (event.key === "Escape") event.preventDefault();
                close(true);
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                close(true);
                onAction();
              }}
            >
              <X size={15} />
              {actionLabel}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
