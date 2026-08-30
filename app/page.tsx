"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "model";
  content: string;
  isStreaming?: boolean;
}

const SUGGESTED_QUERIES = [
  "How's our pipeline looking for the energy sector this quarter?",
  "Give me a leadership update summary",
  "What's our total revenue from completed work orders?",
  "Which deals are at risk of being lost?",
  "Show me operational performance across all sectors",
  "What's our win rate and average deal size?",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "model",
      content:
        "👋 Hello! I'm **Skylark Intelligence**, your AI-powered business intelligence agent.\n\nI have live access to your Monday.com boards — Work Orders and Deals. Ask me anything about your pipeline, revenue, operational metrics, or request a leadership update.\n\nWhat would you like to know?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (text?: string) => {
      const messageText = (text ?? input).trim();
      if (!messageText || isLoading) return;

      const userMessage: Message = { role: "user", content: messageText };
      const history = messages.filter((m) => !m.isStreaming);

      setMessages((prev) => [
        ...prev,
        userMessage,
        { role: "model", content: "", isStreaming: true },
      ]);
      setInput("");
      setIsLoading(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: messageText,
            history: history.map((m) => ({ role: m.role, content: m.content })),
          }),
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(err.error ?? "Request failed");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "model",
              content: accumulated,
              isStreaming: true,
            };
            return updated;
          });
        }

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "model",
            content: accumulated || "I couldn't generate a response. Please try again.",
            isStreaming: false,
          };
          return updated;
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "model",
            content: `❌ Error: ${msg}\n\nPlease check your configuration and try again.`,
            isStreaming: false,
          };
          return updated;
        });
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, messages]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  };

  const showSuggestions = messages.length === 1;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <div className="logo-group">
            <div className="logo-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <path d="M14 2L26 8V20L14 26L2 20V8L14 2Z" fill="url(#hexGrad)" />
                <path d="M14 7L10 9.5V14.5L14 17L18 14.5V9.5L14 7Z" fill="white" opacity="0.9" />
                <path d="M7 11L10 9.5M21 11L18 9.5M14 17V21" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                <defs>
                  <linearGradient id="hexGrad" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#6366f1" />
                    <stop offset="1" stopColor="#0ea5e9" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div>
              <h1 className="logo-title">Skylark Intelligence</h1>
              <p className="logo-sub">Powered by Gemini · Live Monday.com Data</p>
            </div>
          </div>
          <div className="status-badge">
            <span className="status-dot" aria-hidden="true" />
            Live
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <main className="chat-area" id="chat-area" role="log" aria-live="polite" aria-label="Conversation">
        <div className="messages-container">
          {messages.map((msg, i) => (
            <div key={i} className={`message-row ${msg.role}`}>
              {msg.role === "model" && (
                <div className="avatar agent-avatar" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 28 28" fill="none">
                    <path d="M14 2L26 8V20L14 26L2 20V8L14 2Z" fill="url(#hexGrad2)" />
                    <path d="M14 7L10 9.5V14.5L14 17L18 14.5V9.5L14 7Z" fill="white" opacity="0.9" />
                    <defs>
                      <linearGradient id="hexGrad2" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#6366f1" />
                        <stop offset="1" stopColor="#0ea5e9" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              )}
              <div className={`bubble ${msg.role}`}>
                {msg.role === "model" ? (
                  <div className="markdown-body">
                    {msg.isStreaming && !msg.content ? (
                      <div className="thinking-indicator">
                        <span className="thinking-sparkle">⚡</span>
                        <span>Querying Monday.com & analyzing metrics</span>
                        <span className="thinking-dots">
                          <span>.</span><span>.</span><span>.</span>
                        </span>
                      </div>
                    ) : (
                      <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                        {msg.isStreaming && <span className="cursor" aria-hidden="true" />}
                      </>
                    )}
                  </div>
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
              {msg.role === "user" && (
                <div className="avatar user-avatar" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                    <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
                  </svg>
                </div>
              )}
            </div>
          ))}

          {/* Suggested queries */}
          {showSuggestions && (
            <div className="suggestions">
              <p className="suggestions-label">Try asking:</p>
              <div className="suggestions-grid">
                {SUGGESTED_QUERIES.map((q) => (
                  <button
                    key={q}
                    className="suggestion-chip"
                    onClick={() => sendMessage(q)}
                    disabled={isLoading}
                    id={`suggestion-${q.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input Area */}
      <footer className="input-area">
        <div className="input-container">
          <textarea
            ref={textareaRef}
            id="chat-input"
            className="chat-input"
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your pipeline, revenue, operational metrics..."
            rows={1}
            disabled={isLoading}
            aria-label="Chat message input"
          />
          <button
            id="send-button"
            className={`send-btn ${isLoading ? "loading" : ""}`}
            onClick={() => sendMessage()}
            disabled={isLoading || !input.trim()}
            aria-label="Send message"
          >
            {isLoading ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
        <p className="input-hint">Press Enter to send · Shift+Enter for new line</p>
      </footer>
    </div>
  );
}
