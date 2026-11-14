import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import type { AuthorPlan } from "../lib/git";
import ChangeAuthor from "./ChangeAuthor";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

const plan: AuthorPlan = {
  branch: "main",
  head: "a".repeat(40),
  id: "b".repeat(40),
  name: "Original Author",
  email: "original@example.invalid",
  subject: "An older commit",
  affectedCommits: 3,
};

it("previews the author and rewrite scope, requiring confirmation of the edited identity", () => {
  const onSubmit = vi.fn();
  render(
    <ChangeAuthor plan={plan} busy={false} error={null} onClose={vi.fn()} onSubmit={onSubmit} />,
  );
  const name = screen.getByLabelText<HTMLInputElement>("Author name");
  const email = screen.getByLabelText<HTMLInputElement>("Author email");
  const confirm = screen.getByRole<HTMLInputElement>("checkbox");
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Change commit author" });
  expect(name.value).toBe(plan.name);
  expect(email.value).toBe(plan.email);
  expect(screen.getByText(/3 commit\(s\)/).textContent).toContain("main");
  expect(screen.getByText(/lose their signatures/).textContent).toContain("Force push with lease");
  expect(submit.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(submit.disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Updated Author" } });
  fireEvent.change(email, { target: { value: "updated@example.invalid" } });
  expect(confirm.checked).toBe(false);
  fireEvent.submit(submit.closest("form")!);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({
    kind: "changeAuthor",
    branch: plan.branch,
    head: plan.head,
    id: plan.id,
    name: "Updated Author",
    email: "updated@example.invalid",
  });
});

it("locks the submitted values and keeps the draft when the branch changed", () => {
  const props = { plan, busy: false, error: null, onClose: vi.fn(), onSubmit: vi.fn() };
  const { rerender } = render(<ChangeAuthor {...props} />);
  const name = screen.getByLabelText<HTMLInputElement>("Author name");
  fireEvent.change(name, { target: { value: "My corrected name" } });
  fireEvent.click(screen.getByRole("checkbox"));
  rerender(<ChangeAuthor {...props} busy />);
  expect(name.disabled).toBe(true);
  expect(screen.getByLabelText<HTMLInputElement>("Author email").disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  rerender(<ChangeAuthor {...props} error={{ key: "staleAuthorPlan" }} />);
  expect(name.value).toBe("My corrected name");
  expect(name.disabled).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain("branch changed");
});

it("rejects blank or malformed identities without submitting", () => {
  render(
    <ChangeAuthor plan={plan} busy={false} error={null} onClose={vi.fn()} onSubmit={vi.fn()} />,
  );
  const name = screen.getByLabelText("Author name");
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Change commit author" });
  for (const value of [" ", "Name <injected>"]) {
    fireEvent.change(name, { target: { value } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit.disabled).toBe(true);
  }
});
