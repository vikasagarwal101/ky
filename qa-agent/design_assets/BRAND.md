# Ceph Brand Identity

**Product:** Ceph — The Cleaner. Echo killer. Finding suppressor.
**Family:** Waterworks HQ (Orcy + Ceph)
**Codebase:** `qa-agent`

---

## Name

- **Ceph** (4 letters, one syllable — shorthand for *cephalopod*)
- Lowercase in product reference: "run ceph", "ceph cleans"
- Capitalized as **Ceph** at start of sentences and in headings

### Inspiration

Octopuses are cephalopods — deep-sea creatures that move silently, ink when threatened, reach into every crack with countless arms, and disappear without a trace. Ceph dives into repos the same way: reaches into every file, inks the findings into PRs, and leaves only clean water behind.

The name **Ceph** honors this: eight arms, infinite reach, zero noise.

---

## Tagline

> **When Ceph runs, problems die.**

Alternative / sub-taglines:
- **Silence from the depths.**
- **Dive deep. Come up clean.**
- **The echo killer.**

---

> **When Ceph runs, problems die.**

Proposed final (pending Sound): **Keep your waters clean.**

Alternative / sub-taglines:
- **Silence from the depths.**
- **Dive deep. Come up clean.**
- **The echo killer.**
- **Ink and dust.** (short-form / CLI footer)

---

## CLI Verbs

```
ceph init        — onboard a new machine
ceph run         — execute a cycle (ink, scan, duster)
ceph scan        — analyze a tank (alias for run --phase issue-cycle)
ceph ink         — create a findings PR (alias for run --phase pr-cycle)
ceph doctor      — diagnose system health
ceph status      — show tank health overview
ceph preflight   — assess a tank before onboarding
ceph onboard     — add a tank to Ceph's care
ceph heal        — auto-clean transient artifacts
ceph report      — generate health report (PDF / text)
ceph install-cron — set up scheduled cycles
```

### Lexical mapping (converged with Green)

| Ceph term | Maps to | Meaning |
|-----------|---------|---------|
| scan | analyze | Ceph scans a tank for findings |
| ink | PR/submit | Ceph inks findings into a pull request |
| duster | dry-run | Ceph dusts before committing |
| tank | repo | A tank is where Ceph lives, distinct from Orcy's habitat |
| dive | cycle start | Ceph dives into the tank |
| purge | issue fix run | Each cycle is a purge operation |
| lock | claim | Ceph locks onto findings |

---

## Design System: Abyssal Ceph

A dark, deep-sea aesthetic paired with Ocean Orcy's tokens. Ceph lives in the same ocean as Orcy — just deeper, darker, quieter.

### Color Tokens (Abyssal variant of Ocean Orcy)

| Token | Hex | Role |
|-------|-----|------|
| abyss | `#060a0e` | Page background (shared with Orcy) |
| deep | `#0d1824` | Surface background (shared with Orcy) |
| trench | `#091420` | Ceph-specific deeper panels |
| ink | `#111a24` | Elevated panels (shared with Orcy's whale) |
| blowhole | `#e4ecf4` | Primary text (shared with Orcy) |
| echo | `#1e4858` | Links, active states (shared with Orcy) |
| biolum | `#00d4aa` | Ceph accent — teal bioluminescence |
| dorsal | `#2a5f73` | Highlights (shared with Orcy) |
| breach | `#fa746f` | Errors, CTA (shared with Orcy) |
| krill | `#f0c060` | Warnings (shared with Orcy) |
| ink_cloud | `#1a1a2e` | Ceph-specific shadow/overlay |

**Key difference from Orcy:** Ceph swaps Orcy's `echo`-heavy palette for deeper, darker tones with bioluminescent accent (`#00d4aa`) — like a squid's glow in the abyss.

### Typography

- **Headings:** Space Grotesk (shared with Orcy for family consistency)
- **Body:** Manrope (shared)
- **Code:** JetBrains Mono (shared)

---

## Mascot Concept

A stylized **octopus** — tentacles reaching downward into the deep, bioluminescent tips glowing. (Converged on octopus over squid — more arms, more tools, more actions that map to Ceph's operations.)

Form should suggest:
- **Depth** — body positioned as if diving
- **Reach** — tentacles extending in multiple directions, pulling findings from every corner
- **Ink** — subtle ink-cloud silhouette behind, vanishing as it releases
- **Eyes** — calm, all-seeing, unblinking — the octopus is always watching the tank

Style: Minimal vector, similar to Orcy's rounded orca. Same circular badge format for consistency.

For differentiation from Orcy's orca:
- Orcy = horizontal, hunting forward, breach-up energy (orca breaching)
- Ceph = all-directional, reaching patient, depth-first energy (octopus tending the reef)

---

## Voice & Terminology

### Product voice

**Ceph doesn't talk much. When it does, it matters.**

- Quiet, methodical, precise
- Uses ocean/depth/echo metaphors
- Avoids hype — Ceph's job is to make things boring (in a good way)
- When everything is clean, Ceph says nothing

### Terminology map

| Orcy term | Ceph equivalent | Notes |
|-----------|----------------|-------|
| Hunt | Dive | Ceph dives into tanks |
| Habitat | Tank | Where Ceph lives, doesn't own (distinct from Orcy's habitat) |
| Pod | — | Ceph is a solo cleaner (for now) |
| Mission | Purge | Each cycle is a purge operation |
| Claim | Lock | Ceph locks onto findings |
| Surface | Breach | Shared — findings breach into PRs |
| Breach | Breach | Shared |
| Echo | Echo | Shared — Ceph kills echoes |
| — | Ink | PR creation — an octopus inks and disappears |
| — | Depth | Severity / scan intensity |
| — | Duster | Dry-run mode — kicks up dust before settling |
| — | Scan | Analysis pass over a tank |
| — | Reach | Tentacle metaphor for multi-file coverage |

### Copy patterns

- "Ceph found 0 findings." — anything else implies noise
- "No echoes to surface." — the clean state
- "Ink and dust." — after a clean operation (CLI footer)
- "Diving tank_name..." — cycle start
- "Scanning depth: full" — exhaustive scan mode
- "Scanning depth: surface" — quick scan mode
- "Inking findings..." — PR creation phase
- "Duster pass complete." — dry-run success

---

## Logo concept

Circular badge with:
- Deep background (`#091420` trench)
- Octopus silhouette in `#00d4aa` biolum
- Tentacles extending beyond the badge edge, reaching in multiple directions
- "ceph" wordmark at bottom, same arc format as Orcy
- Ink cloud behind the octopus — subtle, like it's already vanished

**File location:** `design_assets/ceph-logo.svg` (create when ready)

---

## Relationship to Orcy

| Dimension | Orcy | Ceph |
|-----------|------|------|
| Role | Pod coordinator | Tank cleaner |
| Metaphor | Orca hunting pod | Octopus tending the reef |
| Direction | Horizontal, forward | All-directional reach |
| Energy | Coordinated, active | Patient, thorough, meticulous |
| Output | Missions surface as PRs | Findings surface as silence |
| Tagline (proposed) | "Hunt as a pod." | "Keep your waters clean." |
| Color accent | `#1e4858` (echo) | `#00d4aa` (biolum) |

Together they form **Waterworks HQ** — the ecosystem for AI-assisted development. Orcy orchestrates; Ceph maintains. One hunts; one cleans.

---

*Brand file v1.1 — 2026-05-09*
*Converged with Green. Awaiting Sound's calls on tagline, mascot, domain.*
*Part of Waterworks HQ*
