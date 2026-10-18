import { useEffect, useMemo, useState } from "react";

import { Card, PageShell } from "../components/page/kit";
import { ask, answerConfirmation } from "../lib/assistant";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { useGlobeStage } from "../lib/useGlobeLayout";
import type { AgentRun, AgentStep, RunSummary, StepState } from "../store/types";
import { useStore } from "../store/useStore";

const EXAMPLES = [
  "Compare the weather and air quality in Pune, Delhi and Mumbai, then recommend the best city for an outdoor event",
  "Find my most starred GitHub repo and show its open issues",
  "Get the top technology headlines and the weather in Chennai",
];

const STATE_LABEL: Record<StepState, string> = {
  pending: "Waiting",
  running: "Running",
  retrying: "Retrying",
  waiting: "Needs your OK",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  denied: "Declined",
};

const seconds = (ms: number | null | undefined) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Turn a saved run (as the server stores it) into the shape the live run uses. */
function fromSaved(detail: Record<string, unknown>): AgentRun {
  const steps = (detail.steps as AgentStep[] | undefined) ?? [];
  const meta = (detail.meta as { latency_ms?: number; timings?: AgentRun["timings"] } | undefined) ?? {};
  return {
    id: String(detail.id),
    task: String(detail.task ?? ""),
    status: detail.status === "error" ? "error" : "done",
    plan: detail.plan ? { ...(detail.plan as NonNullable<AgentRun["plan"]>), steps } : null,
    steps: Object.fromEntries(steps.map((s) => [s.id, s])),
    confirm: null,
    answer: String(detail.answer ?? ""),
    timings: meta.timings ?? null,
    latencyMs: meta.latency_ms ?? null,
    startedAt: Date.parse(String(detail.created_at ?? "")) || Date.now(),
    panels: [],
    error: null,
  };
}

function ArgsText({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return null;
  return (
    <code className="trace-args">
      {entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ")}
    </code>
  );
}

function StepRow({ step, span }: { step: AgentStep; span: number }) {
  const left = step.started_ms != null && span > 0 ? (step.started_ms / span) * 100 : 0;
  const width = step.duration_ms != null && span > 0 ? Math.max(1.5, (step.duration_ms / span) * 100) : 0;
  return (
    <li className="trace-step" data-state={step.state}>
      <span className="trace-dot" aria-hidden="true" />
      <div className="trace-main">
        <div className="trace-line">
          <strong>{step.purpose || step.label}</strong>
          <span className="trace-state">{STATE_LABEL[step.state]}</span>
        </div>
        <div className="trace-meta">
          <code>{step.tool}</code>
          {step.depends_on.length > 0 && <span>after {step.depends_on.join(", ")}</span>}
          {step.attempts > 1 && <span className="trace-retry">{step.attempts} attempts</span>}
          {step.cached && <span>from cache</span>}
          {step.source && <span>{step.source}</span>}
        </div>
        <ArgsText args={step.args} />
        {step.summary && <p className="trace-summary">{step.summary}</p>}
        {step.error && <p className="trace-error">{step.error}</p>}
        <div className="trace-bar" aria-hidden="true">
          {width > 0 && <i style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />}
        </div>
      </div>
      <span className="trace-time">{seconds(step.duration_ms)}</span>
    </li>
  );
}

function RunView({ run }: { run: AgentRun }) {
  const steps = useMemo(() => (run.plan ? run.plan.steps.map((s) => run.steps[s.id] ?? s) : []), [run]);
  const span = useMemo(
    () => Math.max(1, ...steps.map((s) => (s.started_ms ?? 0) + (s.duration_ms ?? 0))),
    [steps],
  );
  const doneCount = steps.filter((s) => s.state === "done").length;
  const timings = run.timings;

  return (
    <>
      <Card
        title="Plan and trace"
        actions={
          <span className="run-status" data-status={run.status}>
            {run.status === "planning" && "Planning"}
            {run.status === "running" && `Running, ${doneCount} of ${steps.length} done`}
            {run.status === "done" && "Finished"}
            {run.status === "error" && "Stopped"}
          </span>
        }
      >
        <p className="trace-task">{run.plan?.goal || run.task}</p>
        {run.status === "planning" && <div className="skeleton" aria-busy="true" aria-label="Planning" />}
        {steps.length > 0 && (
          <ol className="trace">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} span={span} />
            ))}
          </ol>
        )}
        {run.plan && (
          <p className="muted small">
            Plan from {run.plan.source === "model" ? "the language model" : run.plan.source === "template" ? "a template" : "keywords"}
            {run.plan.repairs > 0 && `, repaired ${run.plan.repairs}×`}.
            {timings && ` Planning ${seconds(timings.plan_ms)}, tools ${seconds(timings.execute_ms)}, answer ${seconds(timings.answer_ms)}.`}
            {run.latencyMs ? ` Total ${seconds(run.latencyMs)}.` : ""}
          </p>
        )}
        {run.error && <p className="problem">{run.error}</p>}
      </Card>

      {run.answer && (
        <Card title="Answer">
          <div className="prose answer">
            <Markdown text={run.answer} />
          </div>
        </Card>
      )}
    </>
  );
}

export function AgentPage() {
  useGlobeStage({}, {}, 0.02);
  const live = useStore((s) => s.agent);
  const busy = useStore((s) => s.busy);
  const ready = useStore((s) => s.connection === "ready");
  const confirmation = useStore((s) => s.confirmation);
  const revision = useStore((s) => s.serverRevision);
  const agentMode = useStore((s) => s.settings.agentMode);
  const [text, setText] = useState("");
  const [past, setPast] = useState<RunSummary[]>([]);
  const [viewing, setViewing] = useState<AgentRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.runs().then((runs) => !cancelled && setPast(runs)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const shown = viewing ?? live;

  return (
    <PageShell id="agent" wide>
      <div className="agent-layout">
        <div className="agent-main">
          <Card title="Give Aura a task">
            <form
              className="task-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!text.trim() || busy) return;
                setViewing(null);
                void ask(text.trim());
                setText("");
              }}
            >
              <label className="visually-hidden" htmlFor="agent-task">
                Task for the agent
              </label>
              <textarea
                id="agent-task"
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Describe a job with several parts. Aura works out the steps, runs them in order and shows each one."
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="task-actions">
                <button type="submit" className="btn primary" disabled={!text.trim() || busy || !ready}>
                  {busy ? "Working…" : "Run task"}
                </button>
                <span className="muted small">
                  {agentMode === "auto" ? "Aura decides when a request needs a plan." : agentMode === "plan" ? "Every request gets a plan." : "Planning is off in Settings."}
                </span>
              </div>
            </form>
            <ul className="example-list">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    className="example"
                    disabled={busy || !ready}
                    onClick={() => {
                      setViewing(null);
                      void ask(example);
                    }}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {confirmation && (
            <Card className="confirm-inline" tone="warn" title="Waiting for you">
              <p>{confirmation.prompt}</p>
              <div className="row-buttons">
                <button type="button" className="btn primary" onClick={() => void answerConfirmation(true)}>
                  Yes, go ahead
                </button>
                <button type="button" className="btn" onClick={() => void answerConfirmation(false)}>
                  No, cancel
                </button>
              </div>
            </Card>
          )}

          {shown ? (
            <RunView run={shown} />
          ) : (
            <Card>
              <p className="empty">No run yet. Pick an example above, or say a multi-part request out loud.</p>
            </Card>
          )}
        </div>

        <aside className="agent-side">
          <Card title="Earlier runs">
            {past.length === 0 ? (
              <p className="empty">Runs you start are saved here.</p>
            ) : (
              <ul className="run-list">
                {past.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className="run-item"
                      data-active={viewing?.id === run.id}
                      onClick={() => api.run(run.id).then((detail) => setViewing(fromSaved(detail))).catch(() => useStore.getState().toast("Couldn't open that run.", "error"))}
                    >
                      <span className="run-task">{run.task}</span>
                      <span className="run-sub">
                        {run.step_count} steps
                        {run.meta?.latency_ms ? `, ${seconds(run.meta.latency_ms)}` : ""}, {relativeTime(run.created_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {viewing && (
              <button type="button" className="link-button" onClick={() => setViewing(null)}>
                Back to the current run
              </button>
            )}
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}
