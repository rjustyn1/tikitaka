/**
 * Read-only proof of the two filesystem scopes in a team:
 * shared source code, and each member's durable instruction/skill artefacts.
 * The Agent view is deliberately bounded by the API; it is not a generic
 * private-workspace browser.
 *
 * Shaped for the demo it has to carry. Two things have to land on an audience
 * without narration:
 *   - a note reaches an Agent *because a file was placed in its workspace*, so
 *     every member is listed at once with its skill count. The holder and the
 *     withheld Agent are visible side by side; nobody has to remember what a
 *     dropdown showed a moment ago.
 *   - approval is what makes the change durable, so a governed file can be read
 *     as a before/after diff of exactly what approval wrote.
 *
 * Two sizes. In the rail it is a directory listing only -- the tree, nothing
 * else -- because a code pane squeezed into a 340px column is unreadable and
 * competes with the conversation. Maximised, it becomes a real file viewer.
 * File contents are only ever fetched in the maximised panel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Agent, AgentGroup, AgentWorkspaceFile, SharedCodeFile } from "../types";
import { buildTreeRows } from "./file-tree";
import { buildGovernedDiff, hasGovernedContent } from "./governed";

type ExplorerSource = "shared" | "agent";
type ExplorerFile = SharedCodeFile | AgentWorkspaceFile;

function formatBytes(size: number): string {
  if (size < 1024) return size + " B";
  return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + " KB";
}

function isAgentWorkspaceFile(file: ExplorerFile): file is AgentWorkspaceFile {
  return "kind" in file;
}

export function WorkspaceExplorer({
  group,
  agents,
  refreshKey,
}: {
  group: AgentGroup;
  agents: Agent[];
  /** Changes after task settlement so a completed run shows its final files. */
  refreshKey: string;
}) {
  const [source, setSource] = useState<ExplorerSource>("shared");
  const [selectedAgentId, setSelectedAgentId] = useState(group.members[0]?.agentId ?? "");
  const [files, setFiles] = useState<ExplorerFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState(true);
  const [expanded, setExpanded] = useState(false);
  /** Skill count per member, so "granted vs withheld" is legible at a glance. */
  const [skillCounts, setSkillCounts] = useState<Record<string, number>>({});

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  );

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath),
    [files, selectedPath],
  );
  const governedKind =
    selectedFile && isAgentWorkspaceFile(selectedFile) ? selectedFile.kind : null;

  useEffect(() => {
    if (!group.members.some((member) => member.agentId === selectedAgentId)) {
      setSelectedAgentId(group.members[0]?.agentId ?? "");
    }
  }, [group.members, selectedAgentId]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = source === "shared"
        ? await api.groupCodebase(group.id)
        : await api.groupAgentWorkspace(group.id, selectedAgentId);
      setFiles(response.files);
      setSelectedPath((current) =>
        current && response.files.some((file) => file.path === current)
          ? current
          : response.files[0]?.path ?? null,
      );
    } catch (reason) {
      setFiles([]);
      setSelectedPath(null);
      setContent("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [group.id, selectedAgentId, source]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, refreshKey]);

  /**
   * Counts for every member, not just the selected one. A member whose listing
   * fails is left out rather than shown as zero: "withheld" is the claim this
   * strip makes, and a network error must never be dressed up as one.
   */
  useEffect(() => {
    if (source !== "agent") return;
    let current = true;
    const memberIds = group.members.map((member) => member.agentId);
    void Promise.all(
      memberIds.map((agentId) =>
        api
          .groupAgentWorkspace(group.id, agentId)
          .then((response) => ({
            agentId,
            count: response.files.filter((file) => file.kind === "skill").length,
          }))
          .catch(() => null),
      ),
    ).then((results) => {
      if (!current) return;
      const next: Record<string, number> = {};
      for (const result of results) {
        if (result) next[result.agentId] = result.count;
      }
      setSkillCounts(next);
    });
    return () => {
      current = false;
    };
  }, [group.id, group.members, source, refreshKey]);

  /** Contents are for the viewer only; the rail never reads a file. */
  useEffect(() => {
    if (!expanded || !selectedPath) return;
    let current = true;
    setReading(true);
    setError(null);
    const request = source === "shared"
      ? api.groupCodebaseFile(group.id, selectedPath)
      : api.groupAgentWorkspaceFile(group.id, selectedAgentId, selectedPath);
    void request
      .then((response) => {
        if (current) setContent(response.content);
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setReading(false);
      });
    return () => {
      current = false;
    };
  }, [expanded, group.id, selectedAgentId, selectedPath, source]);

  // Escape closes the viewer, like every other overlay in the app.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const agentLabel = selectedAgent?.name ?? "Selected Agent";
  const title = source === "shared" ? "Shared codebase" : agentLabel + " workspace";
  const subtitle = source === "shared"
    ? "Visible to every team member"
    : "AGENTS.md and saved skills only";

  const rows = useMemo(
    () => buildTreeRows(files.map((file) => ({ path: file.path, size: file.size }))),
    [files],
  );

  const diff = useMemo(
    () => (governedKind ? buildGovernedDiff(content, governedKind) : []),
    [content, governedKind],
  );
  const governed = governedKind ? hasGovernedContent(content, governedKind) : false;
  const addedCount = diff.filter((line) => line.kind === "added").length;
  const showDiff = diffMode && governedKind !== null && governed && !reading;

  const scopeControls = (
    <div className="workspace-explorer-controls" aria-label="Explorer scope">
      <button
        className={"workspace-scope" + (source === "shared" ? " selected" : "")}
        onClick={() => setSource("shared")}
        aria-pressed={source === "shared"}
      >
        Shared code
      </button>
      <button
        className={"workspace-scope" + (source === "agent" ? " selected" : "")}
        onClick={() => setSource("agent")}
        aria-pressed={source === "agent"}
      >
        Agent skills
      </button>
    </div>
  );

  const memberStrip = source === "agent" && (
    <div className="workspace-member-strip" aria-label="Member workspaces">
      {group.members.map((member) => {
        const agent = agents.find((item) => item.id === member.agentId);
        const count = skillCounts[member.agentId];
        const selected = member.agentId === selectedAgentId;
        return (
          <button
            key={member.agentId}
            className={
              "workspace-member" +
              (selected ? " selected" : "") +
              (count === 0 ? " empty" : "")
            }
            onClick={() => setSelectedAgentId(member.agentId)}
            aria-pressed={selected}
            title={
              count === undefined
                ? "Skill count unavailable"
                : count === 0
                  ? "No governed memory has been granted to this Agent"
                  : count + " granted skill file(s) in this Agent's workspace"
            }
          >
            <span className="workspace-member-name">
              {agent?.name ?? "Unknown Agent"}
            </span>
            <span className="workspace-member-count">
              {count === undefined ? "–" : count === 0 ? "none" : count}
            </span>
          </button>
        );
      })}
    </div>
  );

  const emptyMessage = source === "shared"
    ? <>No shared files yet. Start a task to let the team build in <code>./code</code>.</>
    : <>No saved skills yet. Approve a governed note for this Agent to create one.</>;

  /**
   * The tree. `interactive` is false in the rail, where rows are a listing and
   * nothing opens -- a row that looks clickable but shows no file is worse
   * than a row that plainly does not.
   */
  const tree = (interactive: boolean) => (
    <div
      className={"workspace-tree" + (interactive ? " is-interactive" : "")}
      aria-label={source === "shared" ? "Codebase files" : "Agent instruction files"}
      role={interactive ? undefined : "list"}
    >
      {rows.map((row) => {
        const file = files.find((item) => item.path === row.path);
        const kind = file && isAgentWorkspaceFile(file) ? file.kind : null;
        const body = (
          <>
            <span className="workspace-tree-prefix">{row.prefix}</span>
            <span className={"workspace-tree-label" + (row.isDir ? " is-dir" : "")}>
              {row.label}
            </span>
            {kind && (
              <span className={"workspace-file-kind is-" + kind}>
                {kind === "instructions" ? "always" : "skill"}
              </span>
            )}
            {row.size !== undefined && (
              <span className="workspace-file-size">{formatBytes(row.size)}</span>
            )}
          </>
        );
        if (!interactive || row.isDir) {
          return (
            <div
              key={row.path}
              className={"workspace-tree-row" + (row.isDir ? " is-dir" : "")}
              role={interactive ? undefined : "listitem"}
              title={row.path}
            >
              {body}
            </div>
          );
        }
        return (
          <button
            key={row.path}
            className={
              "workspace-tree-row is-file" +
              (row.path === selectedPath ? " selected" : "")
            }
            onClick={() => setSelectedPath(row.path)}
            title={row.path}
          >
            {body}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <section className="workspace-explorer" aria-label="Workspace explorer">
        <div className="workspace-explorer-head">
          <div>
            <span className="workspace-explorer-title">{title}</span>
            <span className="workspace-explorer-subtitle">{subtitle}</span>
          </div>
          <button
            className="workspace-explorer-expand"
            onClick={() => setExpanded(true)}
            title="Open the file viewer"
            aria-label="Maximize workspace explorer"
          >
            ⤢
          </button>
        </div>
        {scopeControls}
        {memberStrip}
        {error ? (
          <p className="workspace-explorer-state" role="alert">{error}</p>
        ) : loading && files.length === 0 ? (
          <p className="workspace-explorer-state">Loading…</p>
        ) : files.length === 0 ? (
          <p className="workspace-explorer-state">{emptyMessage}</p>
        ) : (
          <div className="workspace-tree-scroll">{tree(false)}</div>
        )}
      </section>

      {expanded && (
        <div
          className="modal-backdrop workspace-viewer-backdrop"
          onClick={() => setExpanded(false)}
        >
          <div
            className="workspace-viewer"
            role="dialog"
            aria-modal="true"
            aria-label={title + " file viewer"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workspace-viewer-head">
              <div>
                <h2>{title}</h2>
                <p>{subtitle}</p>
              </div>
              <button
                className="workspace-explorer-expand"
                onClick={() => setExpanded(false)}
                title="Close the file viewer"
                aria-label="Close file viewer"
              >
                ✕
              </button>
            </div>
            {scopeControls}
            {memberStrip}
            {error ? (
              <p className="workspace-explorer-state" role="alert">{error}</p>
            ) : files.length === 0 ? (
              <p className="workspace-explorer-state">{emptyMessage}</p>
            ) : (
              <div className="workspace-viewer-body">
                <div className="workspace-tree-scroll">{tree(true)}</div>
                <div className="workspace-code-preview">
                  <div className="workspace-code-path">
                    <span className="workspace-code-path-text">{selectedPath}</span>
                    {governedKind !== null && governed && (
                      <button
                        className={"workspace-diff-toggle" + (diffMode ? " selected" : "")}
                        onClick={() => setDiffMode((value) => !value)}
                        aria-pressed={diffMode}
                        title={
                          governedKind === "skill"
                            ? "This whole file exists because a note was approved"
                            : "Highlight the governed block approval added to AGENTS.md"
                        }
                      >
                        {diffMode ? "Diff" : "Raw"}
                      </button>
                    )}
                  </div>
                  {governedKind !== null && governed && showDiff && (
                    <div className="workspace-diff-legend">
                      <span className="workspace-diff-added-count">+{addedCount}</span>
                      {governedKind === "skill"
                        ? "added by approval — the file did not exist before"
                        : "added by approval — the rest is the Agent's own file"}
                    </div>
                  )}
                  {reading ? (
                    <p className="workspace-code-state">Reading file…</p>
                  ) : showDiff ? (
                    <pre className="workspace-diff" aria-label="Governed memory diff">
                      {diff.map((line, index) => (
                        <span
                          key={index}
                          className={
                            "workspace-diff-line is-" +
                            line.kind +
                            (line.marker ? " is-marker" : "")
                          }
                        >
                          <span className="workspace-diff-sign">
                            {line.kind === "added" ? "+" : " "}
                          </span>
                          {line.text || " "}
                        </span>
                      ))}
                    </pre>
                  ) : (
                    <pre>{content}</pre>
                  )}
                  {governedKind === "instructions" && !governed && !reading && (
                    <div className="workspace-diff-note">
                      No governed memory in this file. Nothing has been approved
                      into this Agent&apos;s always-on instructions.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
