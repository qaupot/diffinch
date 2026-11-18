import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import HistoryTable from "./HistoryTable";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

function openTable(path = "/repo") {
  const view = render(
    <div>
      <HistoryTable path={path} id="history-table" graphWidth={80}>
        Rows
      </HistoryTable>
    </div>,
  );
  const handles = screen.getAllByRole("separator");
  const table = document.getElementById("history-table")!;
  const header = table.firstElementChild!;
  const initial = [80, 300, 100, 140];
  Object.defineProperty(table.parentElement!, "clientWidth", { value: 620 });
  Array.from(header.children).forEach((cell, index) => {
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, initial[index], 28));
  });
  return { view, table, handles };
}

it.each([
  [0, "90px minmax(100px, 1fr) 100px 140px"],
  [1, "80px minmax(100px, 1fr) 90px 140px"],
  [2, "80px minmax(100px, 1fr) 110px 130px"],
] as const)(
  "resizes neighboring columns at boundary %i and remembers the layout",
  (index, layout) => {
    const { handles, table, view } = openTable();
    fireEvent.keyDown(handles[index], { key: "ArrowRight" });
    expect(table.style.gridTemplateColumns).toBe(layout);
    view.unmount();
    const reopened = openTable();
    expect(reopened.table.style.gridTemplateColumns).toBe(layout);
    fireEvent.doubleClick(reopened.handles[index]);
    expect(reopened.table.style.gridTemplateColumns).toBe("");
    expect(localStorage.getItem("diffinch.graphColumns:/repo")).toBeNull();
  },
);

it("previews a bounded drag, cancels with Escape and saves only on release", () => {
  const { handles, table } = openTable();
  const handle = handles[2];
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => true;
  handle.releasePointerCapture = vi.fn();
  const drag = () => {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 });
  };
  drag();
  expect(table.style.gridTemplateColumns).toBe("80px minmax(100px, 1fr) 168px 72px");
  expect(localStorage.getItem("diffinch.graphColumns:/repo")).toBeNull();
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(table.style.gridTemplateColumns).toBe("");
  drag();
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500 });
  expect(table.style.gridTemplateColumns).toBe("80px minmax(100px, 1fr) 168px 72px");
  expect(localStorage.getItem("diffinch.graphColumns:/repo")).toBe("[80,100,168,72]");
});
