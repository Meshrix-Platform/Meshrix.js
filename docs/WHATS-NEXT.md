# What's Next: Production Use

The only current Meshrix.js outcome is a working product in real use.

## Required closure

1. Fix concrete defects exposed by the current code, focused tests, startup,
   or an actual user journey.
2. Run each changed capability's smallest owning check.
3. Run `npm run verify:acceptance` once for the assembled clean candidate.
4. Deploy that exact candidate as the single-origin Server + Web Console
   instance in the existing Linux virtual machine.
5. Confirm health, Console loading, authentication, and one governed operation
   against the deployed instance.
6. Keep the instance running and use real failures and user friction as the
   next iteration input.

## Decision rule

A failing behavior that prevents startup, login, normal administration,
governed operations, storage, jobs, Workspace use, Gateway use, or installed
Plugin use is current work and must be fixed.

Research programs, publication channels, compatibility matrices, broad host
qualification, speculative safeguards, and future deployment shapes are not
current product-completion criteria. They may be handled later when real use
creates a concrete need.

The completed Functional Convergence work is historical implementation
context. It is not an active plan and must not be regenerated as pending work.
