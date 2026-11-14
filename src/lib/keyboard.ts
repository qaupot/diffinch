/** WebKit versions with out-of-order composition events need the legacy 229 guard. */
export function isComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">) {
  return event.isComposing || event.keyCode === 229;
}
