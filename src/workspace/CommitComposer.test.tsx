import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { snapshot } from "../test/fixtures";
import CommitComposer, { useCommitDraft } from "./CommitComposer";

function Composer({ busy }: { busy: boolean }) {
  const draft = useCommitDraft(false);
  return (
    <CommitComposer
      draft={draft}
      repo={snapshot()}
      busy={busy}
      canCommit={!busy}
      onCommit={vi.fn()}
      onSettings={vi.fn()}
      onAmendChange={vi.fn()}
      discard={null}
    />
  );
}

it("locks the submitted draft while Git is running and restores editing afterward", () => {
  const { rerender } = render(<Composer busy={false} />);
  const [summary, description] = screen.getAllByRole<HTMLInputElement | HTMLTextAreaElement>(
    "textbox",
  );
  fireEvent.change(summary, { target: { value: "Keep this summary" } });
  fireEvent.change(description, { target: { value: "Keep this body" } });
  rerender(<Composer busy />);
  expect(summary.disabled).toBe(true);
  expect(description.disabled).toBe(true);
  for (const checkbox of screen.getAllByRole<HTMLInputElement>("checkbox"))
    expect(checkbox.disabled).toBe(true);
  rerender(<Composer busy={false} />);
  expect(summary.disabled).toBe(false);
  expect(summary.value).toBe("Keep this summary");
  expect(description.value).toBe("Keep this body");
});
