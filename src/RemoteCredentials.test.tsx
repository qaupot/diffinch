import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import RemoteCredentials from "./RemoteCredentials";
import { git, type CredentialTarget } from "./lib/git";
import { deferred } from "./test/fixtures";

vi.mock("./lib/git", () => ({
  git: {
    credentialTargets: vi.fn(),
    credentialAccount: vi.fn(),
    updateCredentials: vi.fn(),
    action: vi.fn(),
  },
}));

const remotes = [
  { name: "origin", url: "https://github.com/example/repo.git" },
  { name: "upstream", url: "https://github.com/upstream/repo.git" },
];
const target: CredentialTarget = {
  destination: "fetch-destination",
  url: remotes[0].url,
  transport: "https",
  storage: "configured",
  helper: {
    current: "inherited",
    available: ["osxkeychain", "manager", "cache"],
    token: "helper-token",
  },
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
  vi.mocked(git.credentialTargets).mockReset().mockResolvedValue([target]);
  vi.mocked(git.updateCredentials).mockReset().mockResolvedValue("credentialsSaved");
  vi.mocked(git.action).mockReset().mockResolvedValue("credentialHelperSaved");
  vi.mocked(git.credentialAccount).mockReset().mockResolvedValue({ username: "saved-user" });
});

it("opens the single remote and saves credentials through the existing helper", async () => {
  const onComplete = vi.fn();
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      authenticationRequired
      onClose={vi.fn()}
      onComplete={onComplete}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("personal access token");
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "test-user" } });
  fireEvent.change(screen.getByLabelText("Personal access token or password"), {
    target: { value: "test-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("credentialsSaved"));
  expect(git.updateCredentials).toHaveBeenCalledWith("/repository", {
    remote: "origin",
    destination: target.destination,
    username: "test-user",
    password: "test-token",
  });
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
});

it("requires a remote choice when an all-remotes fetch has an ambiguous destination", async () => {
  render(
    <RemoteCredentials
      path="/repository"
      remotes={remotes}
      authenticationRequired
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  expect(git.credentialTargets).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save credentials" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "upstream" } });
  await screen.findByLabelText("Username");
  expect(git.credentialTargets).toHaveBeenCalledWith("/repository", "upstream");
});

it("clears entered secrets when changing remote and ignores stale target responses", async () => {
  const pending = deferred<CredentialTarget[]>();
  render(
    <RemoteCredentials
      path="/repository"
      remotes={remotes}
      remote="origin"
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "first-user" } });
  fireEvent.change(screen.getByLabelText("Personal access token or password"), {
    target: { value: "first-token" },
  });
  vi.mocked(git.credentialTargets).mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "upstream" } });
  expect(screen.queryByLabelText("Username")).toBeNull();
  fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "origin" } });
  expect(((await screen.findByLabelText("Username")) as HTMLInputElement).value).toBe("");
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
  await act(async () =>
    pending.resolve([{ ...target, url: "https://stale.example.invalid/repo" }]),
  );
  expect(screen.queryByText("https://stale.example.invalid/repo")).toBeNull();
});

it("saves to the selected push destination and keeps helper failures recoverable", async () => {
  vi.mocked(git.credentialTargets).mockResolvedValue([
    target,
    { ...target, destination: "push-destination", url: "https://push.example.invalid/repo" },
  ]);
  vi.mocked(git.updateCredentials).mockRejectedValue({ key: "credentialsFailed" });
  const onComplete = vi.fn();
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={onComplete}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Destination"), {
    target: { value: "push-destination" },
  });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "push-user" } });
  fireEvent.change(screen.getByLabelText("Personal access token or password"), {
    target: { value: "push-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Git could not complete the credential request",
  );
  expect(git.updateCredentials).toHaveBeenCalledWith("/repository", {
    remote: "origin",
    destination: "push-destination",
    username: "push-user",
    password: "push-token",
  });
  expect(onComplete).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
});

it("configures a helper without credentials and unlocks saving after refreshing settings", async () => {
  vi.mocked(git.credentialTargets).mockResolvedValueOnce([{ ...target, storage: "unavailable" }]);
  const onComplete = vi.fn();
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={onComplete}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Credential helper"), {
    target: { value: "manager" },
  });
  expect(screen.queryByLabelText("Username")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply helper" }));
  await screen.findByLabelText("Username");
  expect(git.action).toHaveBeenCalledWith("/repository", {
    kind: "configureCredentialHelper",
    remote: "origin",
    destination: target.destination,
    helper: "manager",
    token: "helper-token",
  });
  expect(screen.getByRole("status").textContent).toContain("settings saved");
  expect(git.updateCredentials).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});

it("clears secrets and blocks credential writes until a pending helper change is applied", async () => {
  vi.mocked(git.action).mockRejectedValue({ key: "credentialHelperFailed" });
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "test-user" } });
  fireEvent.change(screen.getByLabelText("Personal access token or password"), {
    target: { value: "test-token" },
  });
  fireEvent.change(screen.getByLabelText("Credential helper"), { target: { value: "manager" } });
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
  fireEvent.change(screen.getByLabelText("Personal access token or password"), {
    target: { value: "another-token" },
  });
  expect(
    (screen.getByRole("button", { name: "Save credentials" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Forget credentials" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply helper" }));
  expect((await screen.findByRole("alert")).textContent).toContain("could not read or update");
  expect((screen.getByRole("button", { name: "Apply helper" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
  expect(git.updateCredentials).not.toHaveBeenCalled();
});

it("preserves custom helpers until the user chooses inherited settings for the selected destination", async () => {
  vi.mocked(git.credentialTargets).mockResolvedValue([
    target,
    {
      ...target,
      destination: "push-destination",
      helper: { ...target.helper!, current: "custom", token: "custom-token" },
    },
  ]);
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Credential helper"), {
    target: { value: "cache" },
  });
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "push-destination" } });
  expect((screen.getByLabelText("Credential helper") as HTMLSelectElement).value).toBe("custom");
  expect((screen.getByRole("button", { name: "Apply helper" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(git.action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Credential helper"), { target: { value: "inherited" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply helper" }));
  await waitFor(() =>
    expect(git.action).toHaveBeenCalledWith("/repository", {
      kind: "configureCredentialHelper",
      remote: "origin",
      destination: "push-destination",
      helper: null,
      token: "custom-token",
    }),
  );
});

it("does not show helper configuration for SSH remotes", async () => {
  vi.mocked(git.credentialTargets).mockResolvedValue([
    { ...target, transport: "ssh", helper: null },
  ]);
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  await screen.findByText(/This remote uses SSH/);
  expect(screen.queryByLabelText("Credential helper")).toBeNull();
});

it("ignores a helper save that finishes after switching repositories", async () => {
  const pending = deferred<"credentialHelperSaved">();
  vi.mocked(git.action).mockReturnValueOnce(pending.promise);
  const props = { remotes: [remotes[0]], onClose: vi.fn(), onComplete: vi.fn() };
  const { rerender } = render(<RemoteCredentials {...props} path="/first" />);
  fireEvent.change(await screen.findByLabelText("Credential helper"), {
    target: { value: "manager" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply helper" }));
  rerender(<RemoteCredentials {...props} path="/second" />);
  await screen.findByLabelText("Username");
  await act(async () => pending.resolve("credentialHelperSaved"));
  expect(git.credentialTargets).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("status")).toBeNull();
  expect((screen.getByLabelText("Credential helper") as HTMLSelectElement).value).toBe("inherited");
});

it("checks the saved account only on request without prefilling or exposing credentials", async () => {
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  const check = await screen.findByRole("button", { name: "Check saved account" });
  expect(git.credentialAccount).not.toHaveBeenCalled();
  fireEvent.click(check);
  await screen.findByText("saved-user");
  expect(screen.getByRole("status").textContent).toContain("Saved username: saved-user");
  expect(git.credentialAccount).toHaveBeenCalledWith("/repository", {
    remote: "origin",
    destination: target.destination,
  });
  expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("");
  expect(
    (screen.getByLabelText("Personal access token or password") as HTMLInputElement).value,
  ).toBe("");
  expect(git.updateCredentials).not.toHaveBeenCalled();
});

it("looks up each destination independently and discards a pending result after switching", async () => {
  const pending = deferred<{ username: string | null }>();
  vi.mocked(git.credentialTargets).mockResolvedValue([
    target,
    { ...target, destination: "push-destination" },
  ]);
  vi.mocked(git.credentialAccount)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ username: "push-user" });
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Check saved account" }));
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "push-destination" } });
  fireEvent.click(screen.getByRole("button", { name: "Check saved account" }));
  await screen.findByText("push-user");
  expect(git.credentialAccount).toHaveBeenLastCalledWith("/repository", {
    remote: "origin",
    destination: "push-destination",
  });
  await act(async () => pending.resolve({ username: "old-fetch-user" }));
  expect(screen.queryByText("old-fetch-user")).toBeNull();
  expect(screen.getByText("push-user")).toBeTruthy();
});

it("clears the displayed account when changing remote or helper", async () => {
  render(
    <RemoteCredentials
      path="/repository"
      remotes={remotes}
      remote="origin"
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Check saved account" }));
  await screen.findByText("saved-user");
  fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "upstream" } });
  expect(screen.queryByText("saved-user")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Check saved account" }));
  await screen.findByText("saved-user");
  expect(git.credentialAccount).toHaveBeenLastCalledWith("/repository", {
    remote: "upstream",
    destination: target.destination,
  });
  fireEvent.change(screen.getByLabelText("Credential helper"), { target: { value: "manager" } });
  expect(screen.queryByText("saved-user")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Check saved account" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("reports unavailable accounts and lets users retry after helper failures", async () => {
  vi.mocked(git.credentialAccount)
    .mockResolvedValueOnce({ username: null })
    .mockRejectedValueOnce({ key: "credentialAccountTimedOut" })
    .mockResolvedValueOnce({ username: "unlocked-user" });
  render(
    <RemoteCredentials
      path="/repository"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Check saved account" }));
  await screen.findByText(/No saved account was returned/);
  fireEvent.click(screen.getByRole("button", { name: "Check saved account" }));
  expect((await screen.findByRole("alert")).textContent).toContain("did not respond in time");
  fireEvent.click(screen.getByRole("button", { name: "Check saved account" }));
  await screen.findByText("unlocked-user");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not look up SSH accounts or accounts without a configured helper", async () => {
  vi.mocked(git.credentialTargets)
    .mockResolvedValueOnce([{ ...target, transport: "ssh", helper: null }])
    .mockResolvedValueOnce([{ ...target, storage: "unavailable" }]);
  const { rerender } = render(
    <RemoteCredentials path="/ssh" remotes={[remotes[0]]} onClose={vi.fn()} onComplete={vi.fn()} />,
  );
  await screen.findByText(/This remote uses SSH/);
  expect(screen.queryByRole("button", { name: "Check saved account" })).toBeNull();
  rerender(
    <RemoteCredentials
      path="/unconfigured"
      remotes={[remotes[0]]}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  await screen.findByText(/Choose an installed credential helper above/);
  expect(screen.queryByRole("button", { name: "Check saved account" })).toBeNull();
  expect(git.credentialAccount).not.toHaveBeenCalled();
});
