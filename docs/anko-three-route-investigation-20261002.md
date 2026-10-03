# Anko three-route investigation (2026-10-02)

## Results and scope

These are three concrete executions, one sample per route. The original pair
overlapped; all-SOL ran later. All used the same 1825-byte original task, base
`3f269a72ff69398b1250c584171f32d12c0d8085`, pinned environment and uncapped
completion observation. The 25-minute point was a checkpoint, not a timeout.

- Single SOL/xhigh: **1372.413 s, $0.78903480, reward 1**, commit
  `8834b2cfaadf5ab5686e1001196c12865b75f6ff`.
- Luna-fast/max plus SOL/xhigh Sortie: **2194.002 s, $1.77609408, reward 1**,
  commit `75a5169cc7a2f38cdeffbcd34d6a5565e97312e7`.
- All-SOL/xhigh Sortie: **2320.256 s, $2.43757400, reward 0**, commit
  `4c1bafafc2512aaa1e6d64596d1239eef65c11f7`.

Unknown usage was zero for each comparable run. Prices are retained usage-based
estimates, excluding parent development, subscriptions and invoice adjustments.
All three ran `go test ./...`, made new branches/commits, left clean source, and
ended with native success. Both Sortie runs obtained genuine Mission succeeded
receipts. Those workflow facts do not establish semantic quality or official score.

The first mixed Review found five Medium defects, all-SOL two. Each original
Reviewer corrected its findings and formally tested/self-rechecked in the same
native session. Neither reported residual Major risk; no second Reviewer ran.
Self-recheck was not independent final PASS. All 103 all-SOL assistant records
used SOL/xhigh: Operator 17, Worker 60, initial Review 11, correction 15.

## Time and cost attribution

Observed stage windows, not pure provider computation:

- Mixed: Worker 671.168 s / $0.13467568; Review 332.783 s / $0.31757960;
  correction 1012.423 s / $0.96876320; other 177.628 s. Operator $0.35507560.
- All-SOL: Worker 1304.194 s / $1.14377400; Review 313.686 s / $0.30882520;
  correction 497.173 s / $0.54955760; other 205.203 s. Operator $0.43541720.
- All-SOL versus mixed: **+126.254 s (+5.75%), +$0.66147992 (+37.24%)**.
  Versus single SOL: 1.690640 times elapsed time and 3.089311 times cost.

All-SOL's reduced correction window did not offset its longer implementation.
The Worker itself was approximately single-SOL-length, followed by serial Review,
real fixes and closure. Some rework was useful: it found a callback-option defect
after its first commit, reproduced it, fixed/tested/committed again (342.855 s,
18 requests, $0.36200480). Review then found two additional interoperability defects.

All-SOL Worker used 60 requests / 79 tool calls; single SOL used 33 / 80.
Input-context traffic explains most of the cost difference: uncached input
$0.32260000 versus $0.23927400, cached input $0.55238400 versus $0.25678080,
output/reasoning $0.26879000 versus $0.29298000. Cache-read tokens totaled
5,523,840 versus 2,567,808. Cached input is still billable.

The all-SOL Worker ingested the full 2721-line generated parser diff, growing
recorded context from 81,017 to 134,593 tokens before 26 further requests. This
was a complete read, not overlapping duplicate reads; its counterfactual saving
was not measured. Initial Reviewers also searched unsuccessfully for unavailable
shell tools. Both correction sessions retained native context but started with
zero provider cache-read tokens (104,731 uncached mixed; 102,840 all-SOL).
Native session reuse and provider cache hits are different observations.

## Exact all-SOL score failure

Pinned official tests returned F2P 7/9, P2P 94/94, binary reward 0. Failed groups:
`TestTypedBindingsDeclarations` and `TestTypedBindingsAdditionalRepresentativeFlows`.
The auxiliary partial value 0.9805825242718447 is not the binary score.

`vm/typedBindings.go:60-63` rejects an initializer type mismatch but returns
without clearing `runInfo.rv`. `vm/vmStmt.go:50` exposes that previous value
alongside the error. `var x: int64 = "hello"` consequently returns `"hello"`
instead of nil. Multi-name declarations similarly expose initializer slices.
The file was unchanged from the Worker's first commit to the final candidate.

Read-only source mounts and a diagnostic Go overlay confirmed:

- Single SOL and mixed: all five reported cases produced errors and nil returns.
- All-SOL: five errors, zero nil returns.
- Adding only `runInfo.rv = nilValue` at the failing type-check branch: five
  errors and five nil returns. The first overlay mistakenly targeted a later
  error branch; that failed diagnostic is retained too.

No candidate was changed or officially regraded. The original request does not
explicitly specify nil returns for every error, but the verifier uses the existing
`vm/main_test.go:199-218` helper to check that public result. All three candidates'
corresponding error tests discarded or skipped the returned value. Passing scores
therefore did not reveal the shared test-oracle gap; the two passing implementations
happened to include the reset.

Both relevant source and an instruction to inspect public result, error and
post-failure state were available to Review. Initial Review was static; correction
concentrated on the findings it had identified. This demonstrates a semantic
coverage gap, not missing task text or proof that a different model label fixes it.

## Product-induced detours

The original combined `gofmt -w ... && git add ... && git diff ...` was refused
although its standalone formatter and Git commands were allowed by the same
fixed gate module. Git presence revived the formatter's unrelated executable
ambiguity. The denied-request/rebind interval was 44.852 s / $0.02496320.

Further observed detours included clipped single-line contracts, role-inappropriate
status guidance, missing durable commit/clean observations, and model transcription
of host-generated final cards. Intervals overlap and cannot be added as predicted
savings. The follow-up [Coordinator improvements](coordinator-direct-improvements-20261002.md)
addresses these general workflow issues; it does not encode hidden Anko test cases.

## Reproduction and retained evidence

Package v0.13.3 SHA-256:
`185c300c8a0a8b6e12ba8864319d60ed34d4fcd2896746c42ce6eca636699707`.
Original task SHA-256:
`96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`.

Scoring was local Docker replay of unchanged official verifier bytes, not hosted
submission. Benchmark commit `e837a70bd6beb4e72eeeda62dd06e3bd34f6cb63`, corpus
`435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`, verifier tree SHA-256
`17ec999180d9f09277101cc80c33b8656ce719b3105891a735fc0a8b08d850aa`, image
`sha256:4fb704fd8dff600f6d028c20ae4aca5e1261968bb615bb41c01a111dd371255b`,
2 CPUs / 8 GiB / no network, `bash /tests/test.sh`. Grading followed frozen commits;
no inference or candidate correction followed grading.

Durable archives under `/home/user/Sortie-dogs/_testenv/anko-pr149-ubuntu-20261001/`:
`paired-sol-20261002-isolated/`, `paired-sortie-20261002-isolated/`,
`paired-all-sol-20261002/`, `paired-scoring-20261002/`,
`all-sol-comparison-20261002/`. Detailed investigation/roundtrip evidence also
remains in `/tmp/opencode/reviewer-remediation-pr149-20261001/_testenv/` and its
hashed persistent archive. Native DBs, source/Git, logs and fixed packages are
retained; generated plugin environments were cleaned only after shutdown/archive.

Excluded infrastructure incidents remain separate: shared-DB invalid trials cost
$0.39704296 plus unknown usage 1; earlier run8 was incorrectly stopped at 1500.009 s,
$0.975534 plus unknown 1, with uncommitted Reviewer changes and no completion.
Neither is counted as a comparable completed sample. No Anko push/PR/publication.
