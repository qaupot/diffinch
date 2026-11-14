import type { Commit } from "./git-types";

export function commitAuthor({ author, email }: Pick<Commit, "author" | "email">): string {
  return email ? `${author} <${email}>` : author;
}
