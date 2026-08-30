# TODO Instructions

TODO.md is the baseline findings list. Leave it unchanged.

The four files in this directory are implementation instructions, not a
replacement for the baseline. They are deliberately partitioned so four
people can start concurrently in one shared workspace.

## Concurrency rules

- Read README.md, middlewaredoc/MIDDLEWARE.md, docs/ARCHITECTURE.md,
  middlewaredoc/PLAN.md, and middlewaredoc/SPEC.md before coding.
- Edit only the files in your person's ownership list.
- Do not edit TODO.md, these instruction files, another person's files, or
  generated data.
- Keep changes small and independently typecheckable. Do not reimplement a
  neighboring person's contract.
- Use persisted types and API response shapes for handoffs. Do not solve a
  missing dependency by editing the other person's files.
- Each person should run targeted tests for their own boundary. The full
  npm run check happens after integration.
- Do not start a live demo task while another person is changing runtime or
  workspace behavior.

## Handoffs

- Person 2 publishes the planner result and GroupPlanNode contract.
- Person 1 consumes that contract in GroupRunner and owns runtime execution.
- Person 3 consumes completed execution records but does not edit GroupRunner.
- Person 4 consumes the final server DTOs and owns all browser code.
- Person 4 may use temporary fixtures or tolerant rendering while Person 2's
  instruction field is in flight, but must not add a second planner.

## Integration order

The implementation work can run concurrently. Integrate and run the full check
in this order:

1. Confirm Person 2's persisted planner contract.
2. Confirm Person 1's runtime and workspace lifecycle behavior.
3. Confirm Person 3's memory pipeline against completed task records.
4. Confirm Person 4's web DTO usage and demo flow.


