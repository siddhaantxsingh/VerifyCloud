#!/usr/bin/env bash
# Repeated benchmark runs; each run's JSON + /usr/bin/time -v output kept.
cd /home/claude/projects/verifycloud
O=/tmp/claude-0/audit/bench
/tmp/claude-0/audit/services.sh >/dev/null 2>&1
vmstat -t 5 > $O/vmstat.log &
VM=$!
for i in 1 2 3 4 5; do /usr/bin/time -v -o $O/scheduler-$i.time npx tsx bench/scheduler.ts > $O/scheduler-$i.json 2> $O/scheduler-$i.err; done
for i in 1 2 3; do /usr/bin/time -v -o $O/api-$i.time npx tsx bench/api.ts > $O/api-$i.json 2> $O/api-$i.err; done
for i in 1 2 3; do BENCH_OUT=$O/sandbox-$i.json /usr/bin/time -v -o $O/sandbox-$i.time npx tsx bench/sandbox.ts > $O/sandbox-$i.out 2> $O/sandbox-$i.err; done
# costs measured in the previous run (worker-side, unaffected by the events fix)
kill $VM; echo ALLDONE > $O/done
