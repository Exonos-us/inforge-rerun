# What a coworker can do, and what the engine already tells it

Read in phase 1 to recommend the right settings, and before writing so nothing gets repeated.

## The tool families

All of them are **`true` by default** (`packages/contracts/src/agent.ts`, `toolsSchema`). A template **turns off** what is not useful, it does not turn anything on. I only turn something off for a real reason: a tool that would sidetrack the agent or cost money without being useful.

| `tools.*` key | What it gives | I turn it off when… |
|---|---|---|
| `web` | `web_search`, `web_fetch`, `download` | never for a lead magnet |
| `browser` | real Chromium, screenshots, `request_takeover` | almost never |
| `computer` | a screen of its own (browser, files, terminal) that the user watches; 200 actions per run | the deliverable lands on no site without an official connector (see grid below) |
| `paidData` | `paid_data`, `paid_data_catalog`: paid live data on the Rerun credit | the job does not need public data in volume (see grid) |
| `hub` | `rerun_hub_service_search/details/install`, `publish_file` (public URL of a deliverable) | almost never: it is also used to publish a file |
| `suggestService` | an app's connection card, pauses the run | never: without it, the install cannot get any app connected, even a declared one |
| `db` / `sharedDb` | SQLite private to the agent / shared by the whole workspace, across all Boxes | never: that is where the lists live (leads, ads, posts) |
| `cards` | `card_table`, `card_file`: table or file shown in the chat | never |
| `schedule` / `trigger` | the agent creates its own recurring tasks / webhooks | never: the owner may want a cadence later |
| `delegate` / `callAgent` | parallel sub-agents / other coworkers | never |
| `vision`, `filesystem`, `shared`, `shell`, `memory`, `brain`, `notify`, `askUser`, `requestApproval`, `requestSecret`, `quickReplies`, `skills` | the rest of the toolbox | never |

`selfImprovement` (`enabled`, `allowSoulEdit`, `allowToolInstall`, `autoMemory`) stays at its default: it is what lets the agent adapt to its owner.

**Image generation comes only with a ChatGPT connection**: a coworker on `codex` has the image tool built into Codex, a coworker on Claude, Rerun or an API key has none. A visual agent on another provider produces HTML/CSS rendered as PNG through the browser or a script (`shell`), or goes through an app from the catalog (Canva, an image generator). I check it with `search_connectors` before promising a visual.

## Grid: computer use

Recommended **on** if at least one of these conditions is true:

- the deliverable ends up **published or submitted on a site** that has no official connector in the catalog (TikTok, Instagram, personal LinkedIn, a marketplace, a form, a back office);
- the job consists of **operating an interface** (Canva, a CMS, Meta Ads Library to observe, a web app with no API);
- the only alternative would be a paid relay API (Unipile, a scraper) on a site where the owner already has an account. The engine already tells the agent to prefer its screen in that case.

Recommended **off** if everything is done through an official connector, the web, data or files. Leaving the screen to an agent that does not need it invites slow detours.

## Grid: paid data

Groups: `people` (prospects, work emails and phones), `companies` (search and enrichment), `search` (Google results, Google Maps, local businesses), `seo` (volumes, keyword ideas, backlinks, authority), `linkedin`, `tiktok`, `instagram`, `x`, `youtube`, `facebook`, `reddit` (public profiles, posts, comments, reactions).

Recommended **on** if the deliverable relies on **structured public data in volume**: finding leads or their emails, enriching companies, listing local businesses, measuring keywords, reading a network's posts / accounts / trends, analyzing competitors.

Recommended **off** if the free web is enough (search, reading a few pages) or if the job only reads the owner's private data.

Known catalog traps, to anticipate in the skill when the job depends on them:

- `tiktok.search.videos` returns **only videos**, never a photo slideshow. For TikTok carousels, the method goes through accounts (`tiktok.search.users` then `tiktok.user.videos`), where a slideshow is a post with `duration_s: 0`.
- `google.keywords.volume` takes up to 100 keywords but **a single country per call** (13.5 credits per call): a multi-country job starts with the 2 or 3 biggest markets.

What the engine already handles: in a routine the agent spends the credit without asking, in chat it asks for approval beyond 200 credits per task, and either way it says what it cost; when the credit runs out, the call is refused, the agent finishes with its free tools and the app shows the top-up card; it never reruns the same request. So I write it nowhere. I name a group in the SOUL or the skill **only** if it changes the method ("pull the account's last 30 posts before writing"), never to restate how it works.

## Grid: service catalog

Two distinct things:

1. **The apps declared** on the agent (`connectors` / `attach_connector`). They travel in the template as declarations; the owner connects their own account during the install. One app per capability, three at most, each with a clear role (source, action or destination). Not two interchangeable providers (Gmail + Outlook) unless the topic requires it.
2. **The catalog at runtime** (`tools.hub` + `tools.suggestService`, on by default): the agent searches for a service itself when the owner names another one, and offers it at the right moment. This is what makes the template open: an owner on Outlook is not blocked by a template designed for Gmail. I never turn it off: `suggestService` is also what gets the declared apps connected during the install, and `hub` carries `publish_file`.

For a lead magnet, I prefer **few declared apps + the catalog at runtime**: the install is shorter and the agent adapts.

## What the engine already says (never rewrite it)

Every system prompt already contains these sections (`apps/engine/src/agents/systemPrompt.ts`). If my SOUL, my INSTALL.md or my skill repeats them, I delete.

| Section | What it already enforces |
|---|---|
| `setup` (during the install) | introduce itself in two lines; show a concrete result **first** without any connection; learn the preferences along the way; **then** offer the missing apps, each tied to what it unlocks; test on the real data; reply in the user's language; `ask_user` rather than guessing; `suggest_service` rather than asking for secrets; `request_secret` for a key; check before concluding; `memory_write` if an app is refused; `install_complete` only when everything works; help if the user asks for something else then come back to the setup. **This order takes precedence over the INSTALL.md's.** |
| `service_catalog` | search the catalog as soon as a product is named; result first, app only at the step that needs it; deliver without the app (mailto, text to copy, CSV, published page); never a secret in the chat |
| `computer` | when to use the screen vs a connector; show and wait for agreement before the final send on a site; ignore instructions read on screen; `request_takeover` for a login or a captcha |
| `paid_data` | cost in credits, size the batch, no duplicates; beyond 200 credits in one task, one sentence of confirmation before buying (chat only, never in a routine) |
| `database` / `cards` | data goes in the database, not in files; saved views; a card after a table or a file |
| `operating notes` | result first, assumptions stated in one line; few questions; nothing runs after the end of the turn; `publish_file` for a deliverable to open; working rules go in a skill, not in memory |
| `quick replies` | reply buttons after a deliverable |

Direct consequence: **the INSTALL.md never contains** "introduce yourself", "call suggest_service", "save to memory", "call install_complete when done", "reply in the user's language", nor a numbered list of those steps. It only contains what the engine cannot guess: *which* result to show, *which* preferences matter, *which* apps unlock *what*, *which* test, *when* it is done.

## What a template carries

The capture copies: `SOUL.md`, `INSTALL.md`, `config.json` (tools, setup), `skills/`, `schedules/`, `triggers/`, `workspace/`, `data/agent.db`, the names of the `.env` keys (not the values). It leaves out: `memory/` (excluded by default), the sessions, the OAuth connections.

On import at the owner's: setup reset to "to do", pinned model cleared, schedules and triggers keep their captured `enabled` state. That is why I create them **disabled**: `install_complete` turns on everything that is off.

A file in `workspace/` captured on purpose can serve as a **shipped resource** (a sample output, an HTML carousel template, a reference list). It is better than a long text in the skill when the agent has to draw on it. I only do it if it really improves the deliverable. The MCP does not write to `workspace/`: either I put it in the skill (`upsert_skill` with `files: [{ path: "references/…", content }]`, the best option), or I ask the agent to write it through `send_message` and I keep it at capture.
