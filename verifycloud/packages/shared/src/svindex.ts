// SystemVerilog source indexer — a deliberately PARTIAL parser.
//
// It recognizes declarations by pattern after removing comments and string
// literals: module/interface/package/class/program, function/task, labeled
// assertions and cover properties, module instantiations, port declarations,
// and assignments to identifiers. It does not elaborate parameters, resolve
// generate blocks, macros (`define bodies are not expanded) or hierarchical
// references, and it can be fooled by unusual formatting. Every consumer
// treats its output as navigation hints, never as ground truth
// (docs/ai-debugging.md, "Source intelligence").

export type SymbolKind = "module" | "interface" | "package" | "class" | "program" | "function" | "task" | "assertion" | "cover" | "instance" | "port";

export interface SvSymbol {
  kind: SymbolKind;
  name: string;
  file: string;
  line: number;
  endLine?: number;
  container?: string; // enclosing module/interface/package/class
  detail?: string;    // instance: module type; port: direction; assertion: property text
}

export interface SvAssignment {
  target: string;
  file: string;
  line: number;
  container?: string;
  context: "assign" | "always_comb" | "always_ff" | "always_latch" | "always" | "initial" | "unknown";
  text: string;       // the statement (single line, trimmed, max 300 chars)
  rhsIdentifiers: string[];
}

export interface SvIndex {
  symbols: SvSymbol[];
  assignments: SvAssignment[];
  files: string[];
}

const KEYWORDS = new Set(
  ("module endmodule interface endinterface package endpackage class endclass program endprogram function endfunction task endtask begin end if else case endcase " +
    "for foreach while do repeat forever always always_comb always_ff always_latch initial final assign logic wire reg bit int integer input output inout " +
    "parameter localparam typedef enum struct union packed signed unsigned posedge negedge or and not property endproperty sequence endsequence assert assume cover " +
    "disable iff return void automatic static virtual extends import export generate endgenerate genvar default unique priority inside with new this super null fork join join_any join_none")
    .split(" "),
);

/** Remove comments and string contents, preserving line structure. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"') {
      out += '"';
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        i++;
      }
      out += '"';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";
const identsIn = (s: string) => [...s.matchAll(new RegExp(`(?<![.'$\\w])${IDENT}`, "g"))].map((m) => m[0]).filter((x) => !KEYWORDS.has(x) && !/^\d/.test(x));

export function indexFile(file: string, source: string): { symbols: SvSymbol[]; assignments: SvAssignment[] } {
  const text = stripComments(source);
  const lines = text.split("\n");
  const symbols: SvSymbol[] = [];
  const assignments: SvAssignment[] = [];
  const stack: SvSymbol[] = [];
  let procCtx: SvAssignment["context"] = "unknown";
  let procDepth = 0;
  let depth = 0; // begin/end nesting inside the current procedural block
  const container = () => [...stack].reverse().find((s) => ["module", "interface", "package", "class", "program"].includes(s.kind))?.name;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const ln = li + 1;
    const t = line.trim();
    if (!t) continue;
    let m: RegExpMatchArray | null;
    if ((m = t.match(new RegExp(`^(?:virtual\\s+)?(module|interface|package|class|program)\\s+(?:automatic\\s+|static\\s+)?(${IDENT})`)))) {
      if (!(m[1] === "interface" && /^interface\s+class/.test(t))) {
        const s: SvSymbol = { kind: m[1] as SymbolKind, name: m[2]!, file, line: ln, container: container() };
        symbols.push(s);
        stack.push(s);
      }
    } else if ((m = t.match(/^end(module|interface|package|class|program)\b/))) {
      const kind = m[1];
      for (let k = stack.length - 1; k >= 0; k--)
        if (stack[k]!.kind === kind) {
          stack[k]!.endLine = ln;
          stack.splice(k);
          break;
        }
    }
    if ((m = t.match(new RegExp(`^(?:(?:virtual|static|protected|local|extern|pure)\\s+)*(function|task)\\s+(?:automatic\\s+|static\\s+)?(?:[\\w$:\\[\\]\\s]+?\\s+)?(${IDENT})\\s*[(;]`))))
      symbols.push({ kind: m[1] as SymbolKind, name: m[2]!, file, line: ln, container: container() });
    if ((m = t.match(new RegExp(`^(${IDENT})\\s*:\\s*(assert|assume|cover)\\s+(property|final|#0)?`)))) {
      // collect the property text up to the terminating ';' (max 8 lines)
      let prop = t;
      for (let k = li + 1; k < Math.min(lines.length, li + 8) && !prop.includes(";"); k++) prop += " " + lines[k]!.trim();
      symbols.push({ kind: m[2] === "cover" ? "cover" : "assertion", name: m[1]!, file, line: ln, container: container(), detail: prop.replace(/\s+/g, " ").slice(0, 400) });
    }
    if ((m = t.match(new RegExp(`^(input|output|inout)\\s+(?:wire\\s+|logic\\s+|reg\\s+|var\\s+)?(?:signed\\s+)?(?:\\[[^\\]]*\\]\\s*)*(${IDENT}(?:\\s*,\\s*${IDENT})*)`))))
      for (const name of m[2]!.split(",").map((x) => x.trim())) symbols.push({ kind: "port", name, file, line: ln, container: container(), detail: m[1] });
    if ((m = t.match(new RegExp(`^(${IDENT})\\s*(?:#\\s*\\([^;]*?\\))?\\s+(${IDENT})\\s*\\(`))) && !KEYWORDS.has(m[1]!) && !KEYWORDS.has(m[2]!) && container())
      symbols.push({ kind: "instance", name: m[2]!, file, line: ln, container: container(), detail: m[1] });

    // procedural context tracking (approximate)
    const pm = t.match(/^(always_comb|always_ff|always_latch|always|initial|final)\b/);
    if (pm) {
      procCtx = pm[1] === "final" ? "initial" : (pm[1] as SvAssignment["context"]);
      procDepth = 0;
      depth = 0;
    }
    const begins = (t.match(/\bbegin\b/g) ?? []).length;
    const ends = (t.match(/\bend\b/g) ?? []).length;
    depth += begins - ends;
    if (pm) procDepth = 1;
    // assignments
    const am = t.match(new RegExp(`^assign\\s+(.+?)\\s*=\\s*(.+?);`));
    if (am) {
      for (const target of identsIn(am[1]!.replace(/\[[^\]]*\]/g, "")))
        assignments.push({ target, file, line: ln, container: container(), context: "assign", text: t.slice(0, 300), rhsIdentifiers: [...new Set(identsIn(am[2]!))] });
    } else if (procCtx !== "unknown" && !/^(if|for|case|while)\b/.test(t)) {
      for (const sm of t.matchAll(new RegExp(`(\\{[^}]*\\}|${IDENT}(?:\\s*\\[[^\\]]*\\])*)\\s*(<=|=)(?!=)\\s*([^;]+);`, "g"))) {
        if (/^(parameter|localparam|logic|int|bit|wire|reg)\b/.test(t)) continue;
        const lhs = sm[1]!.replace(/\[[^\]]*\]/g, "");
        for (const target of identsIn(lhs))
          assignments.push({ target, file, line: ln, container: container(), context: procCtx, text: t.slice(0, 300), rhsIdentifiers: [...new Set(identsIn(sm[3]!))] });
      }
    }
    if (procDepth && depth <= 0 && (ends > 0 || (!t.includes("begin") && t.endsWith(";")))) {
      procCtx = "unknown";
      procDepth = 0;
    }
  }
  return { symbols, assignments };
}

export function buildIndex(files: { path: string; content: string }[]): SvIndex {
  const idx: SvIndex = { symbols: [], assignments: [], files: [] };
  for (const f of files) {
    if (!/\.(sv|svh|v|vh)$/i.test(f.path)) continue;
    idx.files.push(f.path);
    const r = indexFile(f.path, f.content);
    idx.symbols.push(...r.symbols);
    idx.assignments.push(...r.assignments);
  }
  return idx;
}

/** Signals referenced in an assertion's property text (after the implication if present). */
export function assertionSignals(propertyText: string): { all: string[]; consequent: string[]; stable: string[] } {
  const body = propertyText.replace(/^.*?property\s*\(/, "").replace(/\belse\b[\s\S]*$/, "");
  const parts = body.split(/\|->|\|=>/);
  const consequent = parts.length > 1 ? parts.slice(1).join(" ") : body;
  const stable = [...consequent.matchAll(new RegExp(`\\$stable\\s*\\(\\s*(${IDENT})`, "g"))].map((m) => m[1]!);
  const all = [...new Set(identsIn(body.replace(/@\s*\(\s*(posedge|negedge)\s+\w+\s*\)/, "").replace(/\$\w+/g, " ")))];
  return { all, consequent: [...new Set(identsIn(consequent.replace(/\$\w+/g, " ")))], stable };
}

/** Modules that instantiate `module` (dependents) and modules it instantiates. */
export function moduleGraph(idx: SvIndex, module: string) {
  const insts = idx.symbols.filter((s) => s.kind === "instance");
  return {
    instantiatedBy: [...new Set(insts.filter((i) => i.detail === module).map((i) => i.container!))],
    instantiates: [...new Set(insts.filter((i) => i.container === module).map((i) => i.detail!))],
  };
}
