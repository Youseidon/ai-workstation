"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function highlightedCode(source: string, language: string) {
  if (!/^(js|jsx|javascript|ts|tsx|typescript|json|python|py|bash|sh|shell|css|sql)$/.test(language)) return source;
  return source.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|import|from|export|if|else|class|def|for|while|true|false|null|None|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b)/g)
    .map((token, i) => /^("|'|\d)/.test(token) ? <span className="text-success" key={i}>{token}</span>
      : /^(const|let|var|function|return|import|from|export|if|else|class|def|for|while|true|false|null|None|SELECT|FROM|WHERE)$/.test(token) ? <span className="text-accent" key={i}>{token}</span> : token);
}

export function CodeBlock({ source, language }: { source: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [error, setError] = useState(false);
  return <div className="chat-code">
    <div className="flex flex-wrap gap-3 border-b border-line px-3 py-1 text-xs text-fg-muted">
      <span className="mr-auto">{language || "text"}</span>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(source); setCopied(true); setError(false); setTimeout(() => setCopied(false), 2000); }
        catch { setError(true); }
      }}>{error ? "Copy failed" : copied ? "Copied" : "Copy"}</button>
    </div>
    <pre style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}><code>{highlightedCode(source, language)}</code></pre>
  </div>;
}

export const AssistantContent = memo(function AssistantContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="assistant-content" data-streaming={streaming}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, node }) => {
      const source = String(children);
      const language = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? "";
      return language || source.endsWith("\n") || node?.position?.start.line !== node?.position?.end.line
        ? <CodeBlock source={source} language={language} />
        : <code>{children}</code>;
    },
    table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
    a: ({ href, children }) => <a href={href && /^(https?:|mailto:|\/|#)/i.test(href) && !href.startsWith("//") ? href : undefined} rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>[Image: {alt ?? "remote image"}]</span>,
  }}>{text}</ReactMarkdown></div>;
});
