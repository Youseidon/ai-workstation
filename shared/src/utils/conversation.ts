export function conversationTitle(input: string): string {
  let text = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[\s#>*`_~-]+/gm, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
  const polite = /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+|i\s+(?:need|want)\s+(?:you\s+)?to\s+|help\s+me\s+(?:to\s+)?|we\s+need\s+to\s+|is\s+there\s+(?:a\s+)?way\s+to\s+|a\s+way\s+to\s+)/i;
  while (polite.test(text)) text = text.replace(polite, "").trim();
  text = text
    .split(/(?:[.!?](?:\s|$)|\s*[;\n]\s*)/, 1)[0]!
    .replace(/,?\s+(?:please|for me|thanks|thank you)\.?$/i, "")
    .replace(/^(?:make|create|build|add|implement)\s+(?:this|that)\s+(?:happen|for me)$/i, "")
    .trim();
  if (text === "") text = "New conversation";
  const words = text.split(" ");
  if (words.length > 9) text = `${words.slice(0, 9).join(" ")}…`;
  if (text.length > 64) text = `${text.slice(0, 61).trimEnd()}…`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
