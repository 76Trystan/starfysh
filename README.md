# Agent Script Compiler (Product Name TBD)

Pay the expensive, brilliant, unreliable intelligence to write and repair cheap, dumb, reliable code, and never pay it to do the same work twice.

## What this is

Browser automation has a trust problem. Hand-written Playwright scripts break every time a site redesigns and someone has to fix them by hand. Live AI agents cost real money on every run and still fail in confident, unexplained ways. Neither of those is something you can leave running without a person watching it.

This project is aimed squarely at that gap. The pitch in one line: browser automation you can actually leave running.

The mechanism is a compiler, not a runtime. The agent works through a task once in a real browser, under instrumentation, and the output is a plain Playwright script. From then on, the script is what runs on your schedule. When the script eventually breaks, because sites always eventually change, a healer diagnoses the failure, patches the smallest possible piece, re-verifies against the live site, and shows you a readable diff of what changed and why. The agent is only in the loop for authoring and healing, never for ordinary runs.

The compiler is how it works. The reliability is what it is for.

## Who it is for

Anyone who runs the same browser-based task repeatedly, cares that it keeps working, and is tired of being the person who fixes it at 3am when the vendor portal changes. Typical fits: data collection from sites without a real API, recurring reporting flows, internal tools that only expose a web UI, and any "I do this every Monday" task that a person keeps stealing back from automation because the automation kept breaking.

If your current options are "pay an agent to re-derive the same workflow every morning and hope" or "maintain a pile of brittle scripts by hand," this is aimed at you.

## How it fits together

```mermaid
flowchart LR
    A[You describe a task] --> B[Agent runs it once in a browser]
    B --> C[Compiler produces a Playwright script]
    C --> D[Verifier replays the script<br/>and proves it works]
    D --> E[Scheduled runs use the script directly]
    E -->|Runs fine| E
    E -->|Something breaks| F[Healer diagnoses the failure]
    F -->|Small patch| G[Re-verify and show a diff]
    G -->|You accept| E
    G -->|You reject| A
```

Two things in that diagram are the whole point. First, the self-loop at `E`: ordinary runs never touch the agent, so they are fast, cheap, and predictable. Second, the path through `F` and `G`: when something breaks, you do not get a mysterious failure and a rewritten script. You get a diagnosis, the smallest possible patch, fresh evidence that it works, and a diff you can read in ten seconds before accepting.

## What we measure

Reliability only means something if it is measurable. The numbers we care about, and intend to publish honestly, are:

- **Mean time between heals.** How long a script survives in the wild before something breaks.
- **Heal success rate.** Of failures the healer attempts, how many produce a patch that verifies.
- **False-heal rate.** Of patches that verify, how many silently do the wrong thing. This is the number that matters most, and the one nobody in this space wants to talk about.
- **Time-to-heal.** Wall clock from breakage detected to patched script running again.
- **Human intervention rate.** What percentage of heals need a person to weigh in before shipping.

If those numbers are good, this is a real product. If they are not, no amount of architecture around them fixes it.

## Status

Early stage. The design is written up in `docs/`, and implementation has not started yet. First things to land, in order: a verifier that can honestly tell you when a generated script is broken and why, then a healer that patches one narrow class of failure with a visible diff and a published false-heal rate. The README will grow as real pieces land.
