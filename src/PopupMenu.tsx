import { useEffectEvent, useId, useLayoutEffect, useRef, type ReactNode } from "react";

const nativePopover = "popover" in HTMLElement.prototype && "showPopover" in HTMLElement.prototype;
const nativeCommands = "commandForElement" in HTMLButtonElement.prototype;
const nativeFocusGroup = "focusGroup" in HTMLElement.prototype;
const nativeAnchor =
  CSS.supports("position-area: block-end") &&
  "ToggleEvent" in window &&
  "source" in ToggleEvent.prototype;

/** One command menu, with native overlays and a fallback for older system webviews. */
export default function PopupMenu({
  open,
  onOpenChange,
  label,
  trigger,
  children,
  buttonClassName = "toolbar-button",
  panelClassName = "",
  className = "",
  title = label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  buttonClassName?: string;
  panelClassName?: string;
  className?: string;
  title?: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const enter = useRef<"first" | "last" | null>(null);
  const items = () => [
    ...(group.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
  ];

  function close(restore = false) {
    if (restore) button.current?.focus({ preventScroll: true });
    if (nativePopover && panel.current?.matches(":popover-open")) panel.current.hidePopover();
    onOpenChange(false);
  }

  const closeFromEffect = useEffectEvent(() => close());

  useLayoutEffect(() => {
    if (!nativeFocusGroup) {
      group.current?.querySelectorAll("button").forEach((item) => {
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
      });
    }
  });

  useLayoutEffect(() => {
    const node = panel.current!;
    if (nativePopover) {
      if (open && !node.matches(":popover-open")) {
        (node.showPopover as (options: { source: HTMLElement }) => void)({
          source: button.current!,
        });
      }
      if (!open && node.matches(":popover-open")) node.hidePopover();
    }
    if (!open) return;
    function position() {
      if (nativePopover && nativeAnchor) return;
      const rect = button.current!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const left =
        panelClassName === "find-menu" || panelClassName === "sync-menu"
          ? rect.right - box.width
          : rect.left;
      const top =
        rect.bottom + 8 + box.height > innerHeight - 8 && rect.top >= box.height + 8
          ? rect.top - box.height - 8
          : rect.bottom + 8;
      node.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`;
    }
    position();
    const enabled = items();
    if (enter.current) enabled[enter.current === "last" ? enabled.length - 1 : 0]?.focus();
    enter.current = null;
    function outside(event: Event) {
      if (!node.contains(event.target as Node) && !button.current?.contains(event.target as Node))
        closeFromEffect();
    }
    const observer = new ResizeObserver(position);
    observer.observe(node);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, panelClassName]);

  return (
    <div className={`dropdown-anchor ${className}`} onClick={(event) => event.stopPropagation()}>
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        title={title}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        {...{ commandfor: id, command: "toggle-popover" }}
        onClick={(event) => {
          enter.current = event.detail === 0 ? "first" : null;
          button.current?.focus({ preventScroll: true });
          if (!nativePopover || !nativeCommands) {
            event.preventDefault();
            onOpenChange(!open);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          enter.current = event.key === "ArrowUp" ? "last" : "first";
          if (!open) onOpenChange(true);
          else {
            const enabled = items();
            enabled[enter.current === "last" ? enabled.length - 1 : 0]?.focus();
            enter.current = null;
          }
        }}
      >
        {trigger}
      </button>
      <div
        ref={panel}
        id={id}
        popover={nativePopover ? "auto" : undefined}
        hidden={!nativePopover && !open}
        className={`dropdown popup-menu ${panelClassName}`}
        data-anchored={(nativePopover && nativeAnchor) || undefined}
        onToggle={(event) => onOpenChange(event.newState === "open")}
        onClickCapture={(event) => {
          if ((event.target as Element).closest("button:not(:disabled)")) close(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (event.key === "Tab") close(true);
          else if (
            ["Home", "End", ...(!nativeFocusGroup ? ["ArrowDown", "ArrowUp"] : [])].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            const enabled = items();
            const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? enabled.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) %
                    enabled.length;
            enabled[next]?.focus();
          }
        }}
      >
        <div
          ref={group}
          {...{ focusgroup: "menu nomemory" }}
          role={nativeFocusGroup ? undefined : "menu"}
          aria-label={label}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
