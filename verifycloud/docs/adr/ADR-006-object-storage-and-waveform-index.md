# ADR-006: Artifacts in S3-compatible storage; waveforms served through an index

Status: accepted (2026-10-07)

## Context

Logs, coverage, compiled models, sources and waveforms are large, immutable
blobs. VCDs can be hundreds of MB; shipping them to a browser is not workable.

## Decision

* All blobs go to an S3-compatible bucket (MinIO in compose, AWS S3 in
  production) under `org/<org>/artifacts/<artifact>/<name>` keys; metadata,
  sha256, size, retention expiry and ownership live in `artifacts`.
  Downloads are authorized by the API (no public bucket, no presigned URL
  needed for the UI).
* Workers upload a VCD index (per-signal value changes) next to the VCD. The
  API answers "signals matching X" and "values of these signals in [t0, t1]
  downsampled to N points" from the index (LRU-cached).
* Retention is per artifact kind, per project, capped by the plan; deleting an
  artifact row enqueues the object for deletion (`storage_gc` trigger), so a
  crashed GC can never leave a row pointing at a deleted object.

## Consequences

* The S3 code path was tested against moto (an S3 emulator), including an
  outage injected with a TCP proxy; MinIO and AWS S3 were not reachable here.
* Waveforms are limited by `MAX_WAVEFORM_BYTES`; FST is not parsed (VCD only).
