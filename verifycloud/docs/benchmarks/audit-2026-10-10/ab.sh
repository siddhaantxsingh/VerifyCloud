#!/usr/bin/env bash
# Interleaved A/B of the scheduler benchmark: baseline 8fdc165 vs audit HEAD, same host, same time window.
O=/tmp/claude-0/audit/bench
while [ ! -f $O/done ]; do sleep 10; done
/tmp/claude-0/audit/services.sh >/dev/null 2>&1
for i in 1 2 3 4; do
  (cd /tmp/claude-0/audit/verifycloud && npx tsx bench/scheduler.ts > $O/ab-base-$i.json 2> $O/ab-base-$i.err)
  (cd /home/claude/projects/verifycloud && npx tsx bench/scheduler.ts > $O/ab-audit-$i.json 2> $O/ab-audit-$i.err)
done
echo ABDONE > $O/ab-done
