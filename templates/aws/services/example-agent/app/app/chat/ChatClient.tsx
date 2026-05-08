'use client';

// Client island for the chat UI. Plain React + useState + native fetch.
// No state library, no streaming — the AWS-3.3 exit criteria is one
// short, sub-second response on a warm cache.

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

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

const EXAMPLE_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: 'Cost',
    prompt: 'Show me my AWS spend for the last 7 days, broken out by service.',
  },
  {
    label: 'Alarms',
    prompt: 'List all active CloudWatch alarms and explain what each one means.',
  },
  {
    label: 'Topology',
    prompt: 'Summarize my VPC topology — subnets, NAT gateways, and load balancers.',
  },
  {
    label: 'ECS',
    prompt: 'Which ECS services are running, and what is the desired vs running task count for each?',
  },
];

export default function ChatClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const logRef = useRef<HTMLOListElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll the log to bottom whenever a turn is appended or busy state
  // toggles. Using a ref + scrollTop avoids a `key`-driven remount.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  // Focus the composer on first mount so an operator can start typing
  // without reaching for the mouse.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(message: string) {
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

  function send(e: FormEvent) {
    e.preventDefault();
    void submit(input.trim());
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Cmd/Ctrl+Enter also submits — convenience for keyboard-driven users.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit(input.trim());
    }
  }

  function pickExample(prompt: string) {
    setInput(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className="chat">
      <ol className="chat-log" ref={logRef} aria-live="polite" aria-label="Chat history">
        {turns.length === 0 && (
          <li className="empty-state">
            <p className="empty-state-title">Ask anything about this AWS account.</p>
            <p className="empty-state-sub">
              The agent answers by calling read-only AWS APIs. Pick a starter or
              type your own question below.
            </p>
            <ul className="example-prompts">
              {EXAMPLE_PROMPTS.map((p) => (
                <li key={p.label}>
                  <button
                    type="button"
                    className="example-prompt"
                    onClick={() => pickExample(p.prompt)}
                  >
                    <span className="example-prompt-label">{p.label}</span>
                    {p.prompt}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )}
        {turns.map((t, idx) => (
          <li key={idx} className={`turn turn--${t.role}`}>
            <div className="turn-role">
              {t.role === 'user' ? 'You' : t.role === 'assistant' ? 'Agent' : 'Error'}
            </div>
            <div className="turn-text">{t.text}</div>
            {t.toolCalls && t.toolCalls.length > 0 && (
              <details className="turn-tools">
                <summary>
                  <span>
                    {t.toolCalls.length} tool call
                    {t.toolCalls.length === 1 ? '' : 's'}
                  </span>
                  <span className="tool-count" aria-hidden="true">
                    {t.toolCalls.length}
                  </span>
                </summary>
                <ul className="tool-list">
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
            <div className="turn-role">Agent</div>
            <div className="turn-text">
              <span className="thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>Thinking&hellip;</span>
            </div>
          </li>
        )}
      </ol>
      <form onSubmit={send} className="chat-form">
        <div className="chat-form-row">
          <label htmlFor="chat-input" className="sr-only">
            Ask about your AWS deploy
          </label>
          <input
            id="chat-input"
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your AWS deploy…"
            disabled={busy}
            autoComplete="off"
            spellCheck="false"
          />
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            aria-label="Send message"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
        <div className="chat-form-hint">
          <span>
            Press <kbd>Enter</kbd> to send, <kbd>Cmd</kbd>+<kbd>Enter</kbd> on
            Mac or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> elsewhere.
          </span>
          <span>Read-only. No mutations are issued.</span>
        </div>
      </form>
    </div>
  );
}
