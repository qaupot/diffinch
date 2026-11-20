import type { Commit } from "./git-types";

export function commitAuthor({ author, email }: Pick<Commit, "author" | "email">): string {
  return email ? `${author} <${email}>` : author;
}

export function splitCommitMessage(message: string) {
  // Git folds the first nonblank paragraph into the subject. Only ASCII spaces,
  // tabs and carriage returns make a line blank.
  const text = message.replace(/^(?:[ \t\r]*\n)+/, "");
  const separator = /\n(?:[ \t\r]*\n)+/.exec(text);
  const title = separator ? text.slice(0, separator.index) : text;
  const lines = [];
  for (const line of title.split("\n")) {
    let end = line.length;
    while (end > 0 && " \t\r".includes(line[end - 1])) end--;
    if (end) lines.push(line.slice(0, end));
  }
  return {
    summary: lines.join(" "),
    description: separator ? text.slice(separator.index + separator[0].length).trimEnd() : "",
  };
}
