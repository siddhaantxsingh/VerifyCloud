export type Confidence = "low" | "medium" | "high";

export interface Evidence {
  kind: "log" | "assertion" | "source" | "waveform" | "diff";
  text: string;
  file?: string;
  line?: number;
}

export interface SourceLocation {
  file: string;
  line: number;
  why: string;
  verified?: boolean; // set by validation: the file and line exist in the job's sources
}

export interface Analysis {
  summary: string;
  rootCause: string;           // "Insufficient evidence to determine root cause." when unknown
  insufficientEvidence: boolean;
  evidence: Evidence[];
  locations: SourceLocation[];
  investigation: string[];
  potentialFix: string | null;
  confidence: Confidence;
  notes: string[];             // validation notes (e.g. removed unverifiable locations)
}

export interface ProviderResult {
  analysis: Analysis;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export const INSUFFICIENT = "Insufficient evidence to determine root cause.";
