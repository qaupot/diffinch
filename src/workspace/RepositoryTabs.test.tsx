import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git } from "../lib/git";
import { snapshot } from "../test/fixtures";
import RepositoryTabs from "./RepositoryTabs";
import { useRepositorySession } from "./useRepositorySession";

vi.mock("../lib/git", async (original) => ({
  ...(await original<typeof import("../lib/git")>()),
  native: true,
  git: { snapshot: vi.fn() },
}));

function SessionTabs() {
  const { tabs, activePath, setSession, closeTab, reorderTab } = useRepositorySession();
  return (
    <RepositoryTabs
      tabs={tabs}
      activePath={activePath}
      onSelect={(path) => setSession((current) => ({ ...current, activePath: path }))}
      onClose={closeTab}
      onReorder={reorderTab}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  for (const method of ["setPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
    Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: vi.fn() });
  }
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => true,
  });
  vi.mocked(git.snapshot).mockImplementation(async (path) => ({
    ...snapshot(path),
    name: path.slice(1),
  }));
  localStorage.setItem(
    "diffinch.session",
    JSON.stringify({ paths: ["/a", "/b", "/c"], activePath: "/b" }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const method of [
    "setPointerCapture",
    "releasePointerCapture",
    "hasPointerCapture",
    "scrollIntoView",
  ]) {
    Reflect.deleteProperty(HTMLElement.prototype, method);
  }
});

function saved() {
  return JSON.parse(localStorage.getItem("diffinch.session")!);
}

async function setup() {
  const view = render(<SessionTabs />);
  await screen.findByRole("button", { name: "a" });
  const list = view.container.querySelector<HTMLElement>(".repository-tab-list")!;
  vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 300, 30));
  for (const node of list.querySelectorAll<HTMLElement>(".repository-tab")) {
    vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
      const index = [...list.querySelectorAll(".repository-tab")].indexOf(node);
      return new DOMRect(index * 100 - list.scrollLeft, 0, 100, 30);
    });
  }
  return { ...view, list };
}

function pointer(
  node: HTMLElement,
  type: "pointerDown" | "pointerMove" | "pointerUp",
  x: number,
  y = 15,
) {
  fireEvent[type](node, { button: 0, clientX: x, clientY: y, pointerId: 1 });
}

it("drops tabs in both directions, retains selection, and restores the saved order", async () => {
  const view = await setup();
  const a = screen.getByRole("button", { name: "a" });
  pointer(a, "pointerDown", 40);
  pointer(a, "pointerMove", 260);
  expect(
    view.list.querySelector('[data-drop-side="after"]')?.getAttribute("data-repository-path"),
  ).toBe("/c");
  expect(saved().paths).toEqual(["/a", "/b", "/c"]);
  pointer(a, "pointerUp", 260);
  fireEvent.click(a, { detail: 1 });
  expect(saved()).toEqual({ paths: ["/b", "/c", "/a"], activePath: "/b" });
  expect(screen.getByRole("button", { name: "b" }).getAttribute("aria-pressed")).toBe("true");
  pointer(a, "pointerDown", 240);
  pointer(a, "pointerMove", 40);
  pointer(a, "pointerUp", 40);
  expect(saved().paths).toEqual(["/a", "/b", "/c"]);
  const b = screen.getByRole("button", { name: "b" });
  pointer(b, "pointerDown", 140);
  pointer(b, "pointerMove", 260);
  pointer(b, "pointerUp", 260);
  view.unmount();
  render(<SessionTabs />);
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /^[abc]$/ }).map((node) => node.textContent),
    ).toEqual(["a", "c", "b"]),
  );
  expect(saved()).toEqual({ paths: ["/a", "/c", "/b"], activePath: "/b" });
});

it.each(["escape", "outside", "cancel", "capture", "blur"])(
  "cancels a drag on %s without changing selection or order",
  async (reason) => {
    const { list } = await setup();
    const a = screen.getByRole("button", { name: "a" });
    pointer(a, "pointerDown", 40);
    pointer(a, "pointerMove", 260);
    if (reason === "escape") fireEvent.keyDown(a, { key: "Escape" });
    else if (reason === "cancel") fireEvent.pointerCancel(a);
    else if (reason === "capture") fireEvent.lostPointerCapture(a);
    else if (reason === "blur") fireEvent.blur(window);
    pointer(a, "pointerUp", 260, reason === "outside" ? 60 : 15);
    fireEvent.click(a, { detail: 1 });
    expect(saved()).toEqual({ paths: ["/a", "/b", "/c"], activePath: "/b" });
    expect(list.querySelector("[data-drop-side]")).toBeNull();
    expect(list.dataset.reordering).toBe("false");
  },
);

it("keeps normal selection and closing separate from dragging", async () => {
  await setup();
  const a = screen.getByRole("button", { name: "a" });
  pointer(a, "pointerDown", 40);
  pointer(a, "pointerMove", 42);
  pointer(a, "pointerUp", 42);
  fireEvent.click(a, { detail: 1 });
  expect(saved()).toEqual({ paths: ["/a", "/b", "/c"], activePath: "/a" });
  fireEvent.click(screen.getByRole("button", { name: "Close a" }));
  expect(saved()).toEqual({ paths: ["/b", "/c"], activePath: "/b" });
});

it("reorders with the keyboard, keeps focus, and announces the new position", async () => {
  await setup();
  const a = screen.getByRole("button", { name: "a" });
  a.focus();
  fireEvent.keyDown(a, { key: "ArrowRight", altKey: true, shiftKey: true });
  expect(saved()).toEqual({ paths: ["/b", "/a", "/c"], activePath: "/b" });
  expect(document.activeElement).toBe(a);
  expect(screen.getByRole("status").textContent).toBe("a, position 2 of 3.");
  fireEvent.keyDown(a, { key: "ArrowLeft", altKey: true, shiftKey: true });
  fireEvent.keyDown(a, { key: "ArrowLeft", altKey: true, shiftKey: true });
  expect(saved().paths).toEqual(["/a", "/b", "/c"]);
  await new Promise(requestAnimationFrame);
  expect(a.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
});

it("scrolls overflowing tabs while holding a drag near an edge and stops after cancellation", async () => {
  const { list } = await setup();
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 30));
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const a = screen.getByRole("button", { name: "a" });
  pointer(a, "pointerDown", 40);
  pointer(a, "pointerMove", 190);
  const initialScroll = list.scrollLeft;
  act(() => frames.shift()!(16));
  expect(list.scrollLeft).toBeGreaterThan(initialScroll);
  fireEvent.keyDown(a, { key: "Escape" });
  expect(cancel).toHaveBeenCalled();
  expect(saved().paths).toEqual(["/a", "/b", "/c"]);
});
