import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import GitModal from "../dialogs/GitModal";
import { git } from "../lib/git";
import { deferred } from "../test/fixtures";
import OperationProgress, { OperationContext } from "./OperationProgress";
import { useGitActivity } from "./useGitActivity";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => vi.useRealTimers());

it("keeps cancellation accessible in a modal and explains a prolonged operation", async () => {
  vi.useFakeTimers();
  const pending = deferred<void>();
  const cancel = vi.spyOn(git, "cancelTransfer").mockResolvedValue(undefined);
  function Harness() {
    const activity = useGitActivity(false, () => {});
    return (
      <OperationContext value={activity}>
        <OperationProgress />
        <GitModal title="Test operation" onClose={() => {}}>
          <button
            onClick={() =>
              void activity.runTransfer(
                "operation",
                async (_id, progress) => {
                  progress(0);
                  await pending.promise;
                },
                "creatingCommit",
              )
            }
          >
            Start
          </button>
        </GitModal>
      </OperationContext>
    );
  }
  render(<Harness />);
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Start" }));
  expect(dialog.getByText("Creating commit…")).toBeTruthy();
  act(() => vi.advanceTimersByTime(31_000));
  expect(dialog.getByText(/Still running/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(dialog.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(dialog.queryByRole("progressbar")).toBeNull();
});
