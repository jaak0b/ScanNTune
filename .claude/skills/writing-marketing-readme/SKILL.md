---
name: writing-marketing-readme
description: Use when writing or revising the README, landing text, release announcements, or any outward-facing text meant to attract new users. Evidence-backed rules for converting a technical hobbyist audience.
---

# Writing marketing text for a technical hobbyist audience

These rules come from a research pass (2026-07). Sourcing, stated honestly: the correlational README/popularity study arXiv 2206.10772 backs the structural basics (a one-line purpose, usage and install sections, images, lists, license, and contribution/reference sections all correlate with repo popularity; correlation, not causation). PostHog's own developer-marketing writing backs the anti-hype and specificity rules. A third-party analysis of Tailscale's Hacker News launches (markepear.dev) backs the peer-voice tone claims. The READMEs of ripgrep and fzf are the concrete pattern examples (fzf for hero plus early screenshot, ripgrep for honest limitations and data-driven comparisons); OrcaSlicer is an example only for community-terminology and feature-list conventions. Rules not traceable to those sources are marked as heuristics. These rules apply to the README and any outward-facing text; in-app text is governed by CLAUDE.md rule 7 instead.

## The register: a knowledgeable peer, not a manual and not an ad

The voice that converts technical hobbyists is a third thing between neutral manual prose and marketing copy: a practitioner talking directly to another practitioner. Here is the problem, here is what this does about it.

- First person is an asset when it carries a real technical story (a real maker who hit a real problem). It becomes a liability the moment it turns into persuasion or self-congratulation.
- Zero hype: no superlatives, no "revolutionary", "effortless", "blazing", "magic". Developers detect marketing spin instantly and find it patronizing. Assume the reader is smart.
- Specifics carry the weight that adjectives cannot: exact numbers ("differs by 0.05% in X"), exact commands, exact method names ("gradient centroid sub-pixel edge estimator", "Taubin circle fit"). Naming the established method is credibility signaling.
- Section split: the hero line and the "why this exists" section may use peer voice and first person. Everything below (how-to steps, how it works, requirements, limitations) is plain technical prose in the same register as the in-app text.

## Structure (in order)

1. **Hero**: one factual spec-like sentence stating function, audience, and payoff mechanism. No slogan. The visitor decides in seconds whether to keep reading.
2. **Badges**: build status, license, version. Near-universal in the example READMEs (ripgrep, fzf) and a cheap credibility signal.
3. **Proof above the fold**: a screenshot or GIF of the tool actually working, plus the concrete output artifact (a code block with a real pasteable result, e.g. `SET_SKEW` or `M221 S...`). Pattern example: fzf. The "visitors bounce without early proof" framing is practitioner heuristic, not study-backed, but images correlating with popularity is study-backed.
4. **CTA with friction-killing microcopy**: the live link plus the genuine trust signals ("free, open source, runs entirely in your browser, nothing uploaded"). Stating local processing as differentiation is a heuristic (it is true and relevant for a scanning tool), not a case-study finding.
5. **Why / how it works**: the measurement principle is itself the selling point when the mechanism is not self-evident. Explaining the method credibly is what separates the tool from eyeballed alternatives and earns the skeptical crowd's trust.
6. **What you get**: name the exact outputs using community terminology (Klipper `SET_SKEW`, `SET_PRESSURE_ADVANCE`, flow %). Specificity doubles as searchable keywords for the exact phrases hobbyists Google.
7. **Honest limitations**: a plain section on requirements and what the tool cannot do (ripgrep's "Why shouldn't I use ripgrep?" pattern). Owning limits up front reads as expertise, not weakness, and pre-empts the skeptical forum reply.
8. **Quickstart / build / license, plus a contributing or reference section**: plain technical prose. Contribution guidelines and reference/documentation sections correlate with higher popularity in the arXiv study; include at least a short pointer.

## Proof beats claims

- Balanced factual comparisons against the status quo (calipers, eyeballed test prints) are strong trust devices; FUD destroys trust (PostHog).
- Heuristics (general practice, not sourced studies): real user quotes beat zero testimonials, but never fabricate and add social proof only as it accrues; do not build the pitch on vanity metrics such as star counts.

## Scannability

Nobody reads top to bottom. Short sections with headers, short paragraphs, bolded key terms, one visible code or output block early. No prose walls.

## Discipline carried over from the project rules

- Terminology: CLAUDE.md rule 7's terminology clause binds all outward-facing text with no exceptions (slicer and firmware setting names verbatim, one term per concept, no invented synonyms).
- Honesty: no setup-specific claim stated as a general truth, no capability overclaim. Every number quoted must be a real measured one.
- No em-dash (rule 6) and no AI attribution (rule 4) anywhere, including the README.
