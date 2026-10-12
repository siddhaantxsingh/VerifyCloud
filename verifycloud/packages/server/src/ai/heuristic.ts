// Rule-based failure analyzer ("heuristic" provider).
//
// This is NOT a language model. It applies a small set of explicit rules to
// the evidence in the failure context and says so in its output. It never
// sends data anywhere. When no rule matches, it answers that the evidence is
// insufficient instead of guessing.
//
// Rules:
//  R1 build failed       → first compiler error, with its source line.
//  R2 assertion failed   → the assertion, its property, and the RTL driving
//                          the checked signals.
//  R2a stability rule    → for a $stable(x) failure where x is driven
//                          combinationally (assign / always_comb) from signals
//                          that are module inputs, hypothesize that x follows
//                          an input that may change during the handshake; if
//                          the waveform shows such an input changing right
//                          before the failure, cite it and raise confidence.
//  R3 timeout            → the test hit its time limit; point at the end of the log.
//  R4 scoreboard failure → the first self-check messages from the log.
import type { FailureContext } from "./context.js";
import { INSUFFICIENT, type Analysis, type Evidence, type SourceLocation } from "./types.js";

export function heuristicAnalysis(c: FailureContext): Analysis {
  const evidence: Evidence[] = [];
  const locations: SourceLocation[] = [];
  const investigation: string[] = [];
  const notes = ["Produced by the rule-based analyzer (not a language model); it only states what its rules can support."];
  const testLabel = c.task.test ? `${c.task.test} (seed ${c.task.seed})` : "build";

  // R1: build failures
  if (c.task.kind === "build") {
    const err = c.diagnostics.find((d) => d.severity === "error") ?? c.diagnostics[0];
    if (!err) return insufficient(`The build failed (${c.task.state}).`, c, notes);
    evidence.push({ kind: "log", text: err.message, file: err.file ?? undefined, line: err.line ?? undefined });
    if (err.file && err.line) locations.push({ file: err.file, line: err.line, why: "compiler diagnostic" });
    return {
      summary: `Compilation failed: ${err.message}`,
      rootCause: `The simulator rejected the source${err.file ? ` at ${err.file}:${err.line}` : ""}: ${err.message}`,
      insufficientEvidence: false,
      evidence,
      locations,
      investigation: ["Open the cited line and fix the reported error.", "Check that the file is listed in verifycloud.yaml in the right order (packages before their users)."],
      potentialFix: null,
      confidence: err.file ? "high" : "medium",
      notes,
    };
  }

  // R3: timeouts
  if (c.task.state === "TIMED_OUT") {
    evidence.push({ kind: "log", text: c.logExcerpt.split("\n").slice(-8).join("\n") });
    return {
      summary: `${testLabel} did not finish within its time limit of ${c.task.timeoutSeconds} s.`,
      rootCause: INSUFFICIENT,
      insufficientEvidence: true,
      evidence,
      locations,
      investigation: [
        "Look at the last lines of the log: which operation was in progress?",
        "Check for a handshake that never completes (valid without ready) or a missing $finish.",
        "Add a simulation-time watchdog in the testbench so hangs fail with a message.",
      ],
      potentialFix: null,
      confidence: "low",
      notes,
    };
  }

  // R2: assertions
  const a = c.assertions[0];
  if (a) {
    evidence.push({ kind: "assertion", text: `${a.name} failed at time ${a.simTime ?? "?"}: ${a.message}`, file: a.file, line: a.line });
    locations.push({ file: a.file, line: a.line, why: `assertion ${a.name}` });
    if (a.property) evidence.push({ kind: "source", text: a.property, file: a.file, line: a.line });
    const stable = a.signals?.stable ?? [];
    const drivers = c.drivers.filter((d) => (a.signals?.consequent ?? []).includes(d.signal));
    for (const d of drivers.slice(0, 4)) {
      evidence.push({ kind: "source", text: `${d.signal} is assigned in ${d.context}: ${d.text}`, file: d.file, line: d.line });
      if (!locations.some((l) => l.file === d.file && l.line === d.line)) locations.push({ file: d.file, line: d.line, why: `drives ${d.signal}` });
    }
    // R2a: stability rule
    const inputs = new Set(c.index?.symbols.filter((s) => s.kind === "port" && s.detail === "input").map((s) => `${s.container}.${s.name}`) ?? []);
    const comb = drivers.filter((d) => stable.includes(d.signal) && (d.context === "always_comb" || d.context === "assign"));
    const fromInputs = comb.flatMap((d) => d.rhs.filter((r) => inputs.has(`${d.container}.${r}`)).map((r) => ({ d, input: r })));
    if (fromInputs.length) {
      const inputNames = [...new Set(fromInputs.map((x) => x.input))];
      const outNames = [...new Set(fromInputs.map((x) => x.d.signal))];
      let confidence: Analysis["confidence"] = "medium";
      if (c.waveform) {
        const changed = waveformChanges(c.waveform.rows, inputNames);
        if (changed.length) {
          confidence = "high";
          evidence.push({ kind: "waveform", text: `In the cycles before the failure, ${changed.join(", ")} changed while the assertion's precondition held:\n${c.waveform.rows}` });
        } else evidence.push({ kind: "waveform", text: `Waveform window around the failure:\n${c.waveform.rows}` });
      }
      const d0 = fromInputs[0]!.d;
      investigation.push(
        `Check whether ${inputNames.join("/")} may legally change while the condition of ${a.name} holds; the protocol allows the master to do so.`,
        `Inspect ${d0.file}:${d0.line}: ${outNames.join("/")} are computed combinationally from ${inputNames.join(", ")} instead of from state captured at the handshake.`,
        "Open the waveform at the failure time and compare the input with the checked outputs.",
      );
      return {
        summary: `${testLabel}: assertion ${a.name} failed — ${outNames.join("/")} changed while ${a.name} required them to be stable.`,
        rootCause: `${outNames.join(" and ")} ${outNames.length > 1 ? "are" : "is"} driven combinationally (${d0.context}) from the module input${inputNames.length > 1 ? "s" : ""} ${inputNames.join(", ")} (${d0.file}:${d0.line}). When ${inputNames.join("/")} changes while the handshake is pending, the outputs change too, which ${a.name} forbids.`,
        insufficientEvidence: false,
        evidence,
        locations,
        investigation,
        potentialFix: `Derive ${outNames.join("/")} from a value registered when the transaction is accepted (for example, capture ${inputNames[0]} at the handshake and decode the registered copy), so the outputs cannot change until the transaction completes.`,
        confidence,
        notes,
      };
    }
    investigation.push(`Open the waveform at time ${a.simTime ?? "of the failure"} and inspect the signals of ${a.name}.`, "Look at the RTL locations listed above for the logic that drives them.");
    return {
      summary: `${testLabel}: assertion ${a.name} failed: ${a.message}`,
      rootCause: INSUFFICIENT,
      insufficientEvidence: true,
      evidence,
      locations,
      investigation,
      potentialFix: null,
      confidence: "low",
      notes,
    };
  }

  // R4: self-check failures
  if (c.checkFailures.length) {
    for (const f of c.checkFailures.slice(0, 5)) evidence.push({ kind: "log", text: f });
    return {
      summary: `${testLabel}: ${c.checkFailures.length} self-check failure(s); first: ${c.checkFailures[0]}`,
      rootCause: INSUFFICIENT,
      insufficientEvidence: true,
      evidence,
      locations,
      investigation: ["Compare expected and actual values in the first failing check.", "Re-run the same seed with a waveform (waveform: always) and inspect the transaction."],
      potentialFix: null,
      confidence: "low",
      notes,
    };
  }
  return insufficient(c.summary ?? `${testLabel} ended with ${c.task.state}.`, c, notes);
}

function insufficient(summary: string, c: FailureContext, notes: string[]): Analysis {
  return {
    summary,
    rootCause: INSUFFICIENT,
    insufficientEvidence: true,
    evidence: c.logExcerpt ? [{ kind: "log", text: c.logExcerpt.split("\n").slice(-10).join("\n") }] : [],
    locations: [],
    investigation: ["Read the full log of the run.", "Re-run with waveforms enabled to collect more evidence."],
    potentialFix: null,
    confidence: "low",
    notes,
  };
}

/** Which of the named signals change value within the waveform table (rows after the header). */
function waveformChanges(table: string, names: string[]): string[] {
  const lines = table.split("\n");
  const header = lines[0]!.split("|").map((s) => s.trim());
  const changed: string[] = [];
  for (const n of names) {
    const col = header.findIndex((h) => h === n || h.endsWith("." + n));
    if (col < 1) continue;
    const vals = new Set(lines.slice(1).map((l) => l.split("|")[col]?.trim()));
    if (vals.size > 1) changed.push(n);
  }
  return changed;
}
