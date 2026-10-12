import { useState } from "react";
import { useParams } from "react-router-dom";

import { get } from "../api";
import { Card, Crumbs, ErrorBox } from "../components/ui";
import { CompareView } from "./Run";

/** Latest run of branch A vs latest run of branch B (or two job ids). */
export function CompareProject() {
  const { id } = useParams();
  const [base, setBase] = useState("main");
  const [head, setHead] = useState("");
  const [regression, setRegression] = useState("");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div>
      <Crumbs items={[{ to: `/projects/${id}`, label: "Project" }, { label: "Compare" }]} />
      <h1>Compare regressions</h1>
      <Card>
        <form
          className="form inline"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              const qs = new URLSearchParams({ base, head });
              if (regression) qs.set("regression", regression);
              setData(await get(`/projects/${id}/compare?${qs}`));
            } catch (x) {
              setErr(x);
              setData(null);
            }
          }}
        >
          <label>Base (branch or run id)<input value={base} onChange={(e) => setBase(e.target.value)} required /></label>
          <label>Head (branch or run id)<input value={head} onChange={(e) => setHead(e.target.value)} required placeholder="feature/x" /></label>
          <label>Regression <span className="muted small">(optional)</span><input value={regression} onChange={(e) => setRegression(e.target.value)} /></label>
          <button className="btn primary">Compare</button>
        </form>
        <ErrorBox error={err} />
      </Card>
      {data && <CompareView data={data} />}
    </div>
  );
}
