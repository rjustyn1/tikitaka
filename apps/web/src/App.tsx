import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, RunTraceSummary, SystemInfo, TraceSpan } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type TraceFilter = "all" | "failed" | "reasoning";

function TracePanel({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<RunTraceSummary | null>(null);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    const params: { type?: string; status?: string } = {};
    if (filter === "failed") params.status = "failed";
    if (filter === "reasoning") params.type = "reasoning";
    api
      .trace(runId, filter === "all" ? undefined : params)
      .then((result) => {
        setSummary(result.summary);
        setSpans(result.spans);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [runId, filter]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const spanIcon = (type: TraceSpan["type"]) => {
    switch (type) {
      case "reasoning": return "💭";
      case "command_exec": return "$";
      case "file_write": return "📄";
      case "tool_call": return "🔧";
      case "agent_message": return "◎";
      case "error": return "✕";
    }
  };

  const statusBadge = (span: TraceSpan) => {
    if (span.type === "command_exec" && span.payload.kind === "command_exec") {
      const code = span.payload.exitCode;
      if (code !== null) {
        return (
          <span
            style={{
              fontSize: "0.7rem",
              padding: "1px 5px",
              borderRadius: 3,
              background: code === 0 ? "var(--color-success, #22c55e)" : "var(--color-danger, #ef4444)",
              color: "#fff",
              marginLeft: 6,
            }}
          >
            exit {code}
          </span>
        );
      }
    }
    if (span.status === "failed")
      return (
        <span
          style={{
            fontSize: "0.7rem",
            padding: "1px 5px",
            borderRadius: 3,
            background: "var(--color-danger, #ef4444)",
            color: "#fff",
            marginLeft: 6,
          }}
        >
          failed
        </span>
      );
    if (span.status === "incomplete")
      return (
        <span
          style={{
            fontSize: "0.7rem",
            padding: "1px 5px",
            borderRadius: 3,
            background: "var(--color-muted, #888)",
            color: "#fff",
            marginLeft: 6,
          }}
        >
          incomplete
        </span>
      );
    return null;
  };

  const renderPayload = (span: TraceSpan) => {
    const expanded = expandedIds.has(span.id);
    const p = span.payload;
    if (p.kind === "reasoning") {
      const lines = p.text.split("\n");
      const preview = lines.slice(0, 3).join("\n");
      const clipped = !expanded && lines.length > 3;
      return (
        <div style={{ marginTop: 4 }}>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              fontSize: "0.8rem",
              opacity: 0.85,
            }}
          >
            {clipped ? preview + "…" : p.text}
          </pre>
          {(lines.length > 3 || p.truncated) && (
            <button
              onClick={() => toggleExpand(span.id)}
              style={{
                fontSize: "0.75rem",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                opacity: 0.6,
                marginTop: 2,
              }}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      );
    }
    if (p.kind === "command_exec") {
      const outputLines = p.output.split("\n");
      const preview = outputLines.slice(0, 5).join("\n");
      const clipped = !expanded && outputLines.length > 5;
      return (
        <div style={{ marginTop: 4 }}>
          <code style={{ fontSize: "0.8rem", display: "block", marginBottom: 4, opacity: 0.9 }}>
            {p.command}
          </code>
          {p.output && (
            <>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontSize: "0.75rem",
                  opacity: 0.75,
                  maxHeight: expanded ? "none" : undefined,
                }}
              >
                {clipped ? preview + "…" : p.output}
              </pre>
              {outputLines.length > 5 && (
                <button
                  onClick={() => toggleExpand(span.id)}
                  style={{
                    fontSize: "0.75rem",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    opacity: 0.6,
                    marginTop: 2,
                  }}
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          )}
        </div>
      );
    }
    if (p.kind === "file_write") {
      return (
        <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: "0.8rem" }}>
          {p.changes.map((c, i) => (
            <li key={i}>
              <code>{c.path}</code>{" "}
              <span style={{ opacity: 0.6 }}>{c.changeKind}</span>
            </li>
          ))}
        </ul>
      );
    }
    if (p.kind === "agent_message") {
      return (
        <p style={{ margin: "4px 0 0", fontSize: "0.8rem", opacity: 0.85 }}>
          {p.text.slice(0, 200)}
          {p.text.length > 200 ? "…" : ""}
        </p>
      );
    }
    if (p.kind === "error") {
      return (
        <p style={{ margin: "4px 0 0", fontSize: "0.8rem", color: "var(--color-danger, #ef4444)" }}>
          {p.message}
        </p>
      );
    }
    return null;
  };

  // Build an id set of spans that are children (have a parentId in the current span list)
  const childIds = new Set(spans.filter((s) => s.parentId !== null).map((s) => s.parentId as string));

  // Render spans: parent reasoning cards contain their children
  const rendered: React.ReactNode[] = [];
  const visited = new Set<string>();

  for (const span of spans) {
    if (visited.has(span.id)) continue;
    visited.add(span.id);
    const isFailed = span.status === "failed" || span.status === "incomplete";
    const children = spans.filter((s) => s.parentId === span.id);
    children.forEach((c) => visited.add(c.id));

    const cardStyle: React.CSSProperties = {
      border: "1px solid var(--color-border, rgba(0,0,0,0.12))",
      borderLeft: isFailed
        ? "3px solid var(--color-danger, #ef4444)"
        : span.type === "reasoning"
          ? "3px solid var(--color-accent, #6366f1)"
          : "1px solid var(--color-border, rgba(0,0,0,0.12))",
      borderRadius: 6,
      padding: "8px 10px",
      marginBottom: 8,
      fontSize: "0.85rem",
    };

    rendered.push(
      <div key={span.id} style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: "monospace", opacity: 0.5, fontSize: "0.7rem" }}>
            {String(span.seq).padStart(3, "0")}
          </span>
          <span>{spanIcon(span.type)}</span>
          <span style={{ fontWeight: 600 }}>{span.type}</span>
          {statusBadge(span)}
          {span.durationMs !== null && (
            <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.7rem" }}>
              {span.durationMs}ms
            </span>
          )}
        </div>
        {renderPayload(span)}
        {children.map((child) => {
          const childFailed = child.status === "failed" || child.status === "incomplete";
          return (
            <div
              key={child.id}
              style={{
                marginTop: 8,
                marginLeft: 16,
                borderLeft: childFailed
                  ? "2px solid var(--color-danger, #ef4444)"
                  : "2px solid var(--color-border, rgba(0,0,0,0.15))",
                paddingLeft: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontFamily: "monospace", opacity: 0.5, fontSize: "0.7rem" }}>
                  {String(child.seq).padStart(3, "0")}
                </span>
                <span>{spanIcon(child.type)}</span>
                <span style={{ fontWeight: 500 }}>{child.type}</span>
                {statusBadge(child)}
              </div>
              {renderPayload(child)}
            </div>
          );
        })}
      </div>,
    );
  }

  // Render any un-parented spans not yet visited (shouldn't happen often)
  for (const span of spans) {
    if (!visited.has(span.id)) {
      visited.add(span.id);
      rendered.push(
        <div
          key={span.id}
          style={{
            border: "1px solid var(--color-border, rgba(0,0,0,0.12))",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 8,
          }}
        >
          <span>{spanIcon(span.type)}</span>{" "}
          <span style={{ fontWeight: 600 }}>{span.type}</span>
          {statusBadge(span)}
          {renderPayload(span)}
        </div>,
      );
    }
  }

  return (
    <div className="settings-panel" style={{ overflowY: "auto", maxHeight: "100vh" }}>
      <div className="settings-title">
        <div>
          <span className="eyebrow">Run trace</span>
          <h2>Agent execution steps</h2>
        </div>
        <button type="button" onClick={onClose}>×</button>
      </div>

      {summary && (
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 16,
            fontSize: "0.82rem",
          }}
        >
          <span><strong>{summary.spanCount}</strong> spans</span>
          <span style={{ color: summary.failedSpanCount > 0 ? "var(--color-danger, #ef4444)" : undefined }}>
            <strong>{summary.failedSpanCount}</strong> failed
          </span>
          <span><strong>{summary.reasoningCount}</strong> reasoning</span>
          <span><strong>{summary.actionCount}</strong> actions</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["all", "failed", "reasoning"] as TraceFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "3px 10px",
              borderRadius: 4,
              border: "1px solid var(--color-border, rgba(0,0,0,0.2))",
              background: filter === f ? "var(--color-accent, #6366f1)" : "transparent",
              color: filter === f ? "#fff" : "inherit",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            {f === "all" ? "All" : f === "failed" ? "Failed only" : "Reasoning only"}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spinner />
        </div>
      ) : spans.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>No spans recorded for this run.</p>
      ) : (
        <div>{rendered}</div>
      )}
    </div>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setShowSettings(false);
    setTraceRunId(null);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setRuns(result.runs);
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) {
          setActiveRun(result.run);
          setRuns((prev) => prev.map((r) => r.id === result.run.id ? result.run : r));
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((prev) => [result.run, ...prev]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {traceRunId && (
              <TracePanel runId={traceRunId} onClose={() => setTraceRunId(null)} />
            )}

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => {
                    const msgRun = message.role === "assistant"
                      ? runs.find((r) => r.id === message.runId)
                      : null;
                    const hasTrace = msgRun?.traceSummary && msgRun.traceSummary.spanCount > 0;
                    return (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                          {hasTrace && msgRun && (
                            <button
                              className="button button-ghost"
                              style={{ fontSize: "0.72rem", padding: "2px 8px", marginLeft: 8 }}
                              onClick={() => setTraceRunId(msgRun.id)}
                            >
                              {msgRun.traceSummary!.failedSpanCount > 0
                                ? `trace (${msgRun.traceSummary!.failedSpanCount} failed)`
                                : `trace (${msgRun.traceSummary!.spanCount} spans)`}
                            </button>
                          )}
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    );
                  })
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                    {activeRun.traceSummary && activeRun.traceSummary.spanCount > 0 && (
                      <button
                        className="button button-ghost"
                        style={{ marginTop: 8, fontSize: "0.8rem" }}
                        onClick={() => setTraceRunId(activeRun.id)}
                      >
                        View trace ({activeRun.traceSummary.spanCount} spans)
                      </button>
                    )}
                  </article>
                )}
                {activeRun &&
                  ["completed", "cancelled"].includes(activeRun.status) &&
                  activeRun.traceSummary &&
                  activeRun.traceSummary.spanCount > 0 && (
                    <div style={{ textAlign: "right", padding: "4px 0" }}>
                      <button
                        className="button button-ghost"
                        style={{ fontSize: "0.78rem" }}
                        onClick={() => setTraceRunId(activeRun.id)}
                      >
                        View trace ({activeRun.traceSummary.spanCount} spans,{" "}
                        {activeRun.traceSummary.failedSpanCount} failed)
                      </button>
                    </div>
                  )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
