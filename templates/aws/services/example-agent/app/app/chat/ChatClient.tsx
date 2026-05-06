'use client';

// Client island for the chat UI. Plain React + useState + native fetch.
// No state library, no streaming — the AWS-3.3 exit criteria is one
// short, sub-second response on a warm cache.

import { useState, type FormEvent } from 'react';

interface ToolCall {
  name: string;
  input: unknown;
  output: unknown;
}

interface Turn {
  role: 'user' | 'assistant' | 'error';
  text: string;
  toolCalls?: ToolCall[];
}

export default function ChatClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setTurns((prev) => [...prev, { role: 'user', text: message }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        let reason = `${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          reason = j.error ?? reason;
        } catch {
          // ignore — the status code is enough
        }
        setTurns((prev) => [
          ...prev,
          { role: 'error', text: `Error ${res.status}: ${reason}` },
        ]);
        return;
      }
      const data = (await res.json()) as {
        message: string;
        toolCalls?: ToolCall[];
      };
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: data.message,
          toolCalls: data.toolCalls ?? [],
        },
      ]);
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        { role: 'error', text: `Network error: ${(err as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <ol className="chat-log">
        {turns.length === 0 && (
          <li className="hint">
            Ask anything about the AWS account this agent runs in. Try:{' '}
            <em>&ldquo;how many ECS services are running and what&rsquo;s the Aurora cluster status?&rdquo;</em>
          </li>
        )}
        {turns.map((t, idx) => (
          <li key={idx} className={`turn turn--${t.role}`}>
            <div className="turn-role">{t.role}</div>
            <div className="turn-text">{t.text}</div>
            {t.toolCalls && t.toolCalls.length > 0 && (
              <details className="turn-tools">
                <summary>
                  {t.toolCalls.length} tool call
                  {t.toolCalls.length === 1 ? '' : 's'}
                </summary>
                <ul>
                  {t.toolCalls.map((tc, j) => (
                    <li key={j}>
                      <code>{tc.name}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
        {busy && (
          <li className="turn turn--pending">
            <div className="turn-role">assistant</div>
            <div className="turn-text">Thinking…</div>
          </li>
        )}
      </ol>
      <form onSubmit={send} className="chat-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your AWS deploy…"
          disabled={busy}
          aria-label="chat input"
        />
        <button type="submit" disabled={busy || input.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
