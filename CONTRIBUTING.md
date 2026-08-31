# Contributing to Vero Relayer Service

## Environment Setup

1. **Node.js Version**
   This project uses a locked Node.js runtime version to ensure environment consistency. We recommend using [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager).
   
   To switch to the correct version, simply run:
   ```bash
   nvm use
   ```

2. **Environment Variables**
   The project requires certain environment variables to be set. We provide a `.env.example` file as a blueprint.
   
   Copy the example file to `.env`:
   ```bash
   cp .env.example .env
   ```
   Then open `.env` in your editor and configure the variables with your local secrets. Do NOT commit the `.env` file containing real secrets to the repository.

## Code of Conduct

This project and everyone participating in it is governed by the [Vero Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Writing the pull request description

**Every pull request needs a detailed description.** A one-line summary, a
restatement of the issue title, or "fixes the issue" is not enough, and a PR
that arrives with one will be sent back before review.

Write it for a reviewer who has *not* read the issue. Cover:

- **What was wrong** — the problem or gap, and the behaviour before your change.
- **What you did** — the approach you took, and any alternative you considered
  and rejected, with the reason.
- **What to look at** — anything subtle, risky, or that you are unsure about.
  Flagging your own uncertainty speeds review up; it does not count against you.
- **How you verified it** — tests you added, commands you ran, manual checks.

Two things this is not: it is not a diff summary — the diff already says which
lines changed, and the description should say *why*. And it is not a place to
hide problems. If something is incomplete or a known limitation remains, say so
explicitly.

Keep the `Closes #<issue-number>` reference in the description itself. GitHub
ignores closing keywords written in PR comments, so a link posted as a comment
will not close the issue on merge.
