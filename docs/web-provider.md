# GPT-6 Pro Web: setup and recovery

English | [中文](web-provider.zh.md)

This branch implements the opt-in `chatgpt / gpt-6-pro-web / pro` route on an unmodified DSH host. It adds a dedicated Chrome process, a private local daemon, durable browser and request journals, exact image versions, and setup/recovery controls on the existing ChatGPT provider card. It is an unreleased candidate. A registry installation of an older package does not acquire these changes.

The signed-in ChatGPT website still needs manual acceptance with the intended account and operating system. The real Chromium fixture suite exercises browser mechanics against a local website; the stock AgentLoop suite exercises host tools and checkpoints. Neither proves entitlement, the current signed-in website layout, or an end-to-end live Pro result. Unknown or conflicting website evidence stops a request.

## Prerequisites and explicit host policy

Use a supported Node 22/24 line, a local graphical Chrome/Chromium installation, and a POSIX host. The implementation supports Chrome discovery paths on macOS and Linux. The stock host gate uses released DSH `0.2.2-rc.5`; broader peer ranges and a successful package import are not claims of live acceptance on every release. Windows profile durability is not implemented.

DSH continues to own all tools, permissions, authoritative history, retries and compaction. The Web provider cannot enforce `maxTokens`, `temperature` or `stop`, and rejects them. Configure an explicit non-Web summary route in the **actual running compaction service** before enabling the model. A plugin-local configuration claim is insufficient. Also select an explicit local token budget; it is an admission/compaction budget, not a discovered ChatGPT context capacity.

For a stock profile whose entries are named `chatgpt`, `compaction-basic` and `session-title-llm`, merge these values into the corresponding existing configurations:

```yaml
- id: chatgpt
  config:
    # Preserve this entry's provider, stateDir and other existing settings.
    modelContextWindowLimits:
      gpt-6-pro-web: 32768
    webMaxInputBytes: 262144
    # Optional if Chrome is not at a standard location:
    # webChromeExecutable: /absolute/path/to/chrome

- id: compaction-basic
  config:
    auto: true
    modelPolicies:
      - provider: chatgpt
        model: gpt-6-pro-web
        headroomTokens: 4096
        retainTokens: 4096
        summarizationProvider: chatgpt
        summarizationModel: gpt-6.2-sol
        maxTokens: 4096

- id: session-title-llm
  config:
    # Preserve the title plugin's existing target and timeout fields.
    provider: chatgpt
    model: gpt-6.2-sol
```

Use a summary/title model available to your own configured provider; `gpt-6.2-sol` is an example, not an entitlement check. The plugin resolves that route through `ctx.llm.resolveModelInfo`. Exact model policies override the compaction defaults. Empty summary pairs, Web fallback, disabled auto compaction, duplicate target policies and impossible headroom/retention are rejected. Known active stock model-title plugins require their own explicit non-Web pair; alternatively disable that optional title plugin and retain the host's deterministic title service. The plugin reads these settings and never silently rewrites them or chooses a chargeable fallback.

## Enable the model

1. Install the built candidate into the intended DSH profile and restart that host.
2. Open **Settings → Models → ChatGPT → GPT-6 Pro Web** and choose **Open dedicated Chrome**. This creates a private profile under `<stateDir>/web/profile`; it does not attach to your ordinary browser.
3. Sign in interactively in that dedicated window. Leave exactly one ChatGPT page open. Select the visible **GPT-6** model and **Pro** effort. Resolve any login, challenge or account prompt yourself.
4. Choose **Verify account and Pro**. The host reads visible account/model controls and binds the profile to that account. It does not read cookie/token stores or change account memory/privacy settings.
5. Resolve any listed host-policy issues, then choose **Enable Web model**. The normal model selector now offers **GPT-6 Pro Web**, with the single effort `pro`.

The Web account and SIWC grant are independent. If your explicit summary/title route uses SIWC, that grant must also be usable. GPT-6.2 and UltraFast continue through the existing SIWC route. Disabling Web prevents new Web admission; the daemon and another client's work are not terminated by disposing one plugin client.

Chrome executable, prompt-byte limit and idle timeout are saved by explicit setup. A later setup can update explicitly supplied values when no Chrome/engine is active; omitted values keep their previous settings. If an active runtime uses different settings, release its clients and let it shut down before retrying setup. Status, verification and connection do not silently change those saved values.

Every fresh generation creates an empty private **project-only Project** and its own chat after durable intent is recorded. A continuation is accepted only when the DSH prefix, receipt chain, account, Project, conversation and visible transcript still agree. Compaction, forks or changed instructions/tool history create a fresh generation from the current host input. The bridge never generates a private replacement summary or truncates history to fit. Project-only/private/empty-source evidence and exact model controls are verified again before sending; unknown layout fails explicitly.

DSH roles, instructions, history and tool definitions are projected into a website prompt. This does not replace the website's own system instructions or prove that every account personalization setting is absent. The adapter creates no share links and does not inspect every pre-existing conversation share link; a private Project check alone is not a claim that a person could never have shared a chat. It leaves account privacy and memory settings under the account owner's control.

## Images and complete responses

User and tool-result images are resolved through the public DSH attachment service from a detached request snapshot. Offloaded images stay offloaded. PNG, JPEG, WebP and GIF bytes are checked against their declared MIME type, byte length and SHA-256 digest. The supported transport limit is 20 MiB per image, at most 20 distinct versions, and 32 MiB for the complete local request body including base64 overhead. These are local bounds, not promises of website acceptance.

The private blob store retains each exact image version once. Journal requests contain digest references; every reopened reference is verified and hydrated before use. The website receives content-addressed names, and the bridge checks the complete upload set both in the composer and on the accepted prompt. Missing or corrupt bytes stop the profile instead of silently omitting the image. Arbitrary paths, remote URLs and file attachments are not accepted.

The complete prompt envelope has a default 256 KiB byte budget. Responses, receipt framing and inspection remain within a 1 MiB bound. The page must return a complete JSON envelope for the exact request. The engine validates every block and tool schema before persistence; the client validates response, finish and EOF before exposing any DSH chunk. It reports no fabricated thinking text or usage. Tools execute only after the finite model response closes, in the ordinary stock DSH AgentLoop.

The browser transport currently has a 10-minute operation/response observation deadline, alongside shorter waits for UI controls. Host cancellation can end it sooner. If a Pro response outlasts observation, the outcome remains uncertain and can be recovered later from the page; a timeout does not authorize another Send. Include long thinking/queue periods in target-account acceptance.

## Inspect, recover and abandon

The provider card offers **Load turns**, **Inspect**, **Recover from page evidence** and an explicit abandonment action. The list shows the newest 100 turn summaries; older turns remain inspectable by their exact ID through the CLI. Inspection shows recorded state and any completed response. It never executes tool blocks. Recovery observes the website and updates local evidence; it never clicks Send or runs a tool. A profile-fence error identifies the actual unresolved turn, even when a different new request encountered that fence.

| State or error | Meaning and next action |
| --- | --- |
| `WEB_UNCERTAIN` | A dispatched request lacks a completely verified delivery. Inspect its `requestId`/turn ID and recover before any new request. |
| `WEB_DELIVERY_CLAIMED` | A tool response already committed its one delivery owner. Reconnecting cannot replay it. Reconcile the DSH session/tool history. |
| Finished page response with an invalid envelope | Explicit recovery may prove terminal failure only after rechecking the exact prompt, account, Project, response identity/text and transcript against durable evidence. The request remains a failed tombstone; no blocks execute and no successful continuation prefix is created. Changed or insufficient evidence remains unknown. |
| `failed` with pre-Send browser evidence | Recovery can prove there was no Send intent. The old request remains terminal; explicitly abandon its browser evidence before new work, and inspect any remaining draft/upload. |
| `discarded` plus `uncertain` | The result is abandoned, but the remote operation remains unknown. Continue read-only recovery; abandonment does not clear that fence. |
| Binding, journal, image or ownership error | Inspect the saved state. Re-running setup cannot replace an existing account binding or erase its evidence. |

A completed text response may be replayed for the same exact request. A tool-bearing response gets one durable delivery claim; even the same delivery owner cannot request a second executable replay. This is not a host persistence ACK or proof that a tool executed. A new semantic request, a new DSH session and a new Flywheel task are separate identities, which is why Flywheel also needs its consumer-side unknown-outcome fence.

Protocol-invalid terminal evidence retains at most 1 MiB of response text and includes the complete host response/framing budget check. Generic website alerts, account changes, timeouts, incomplete generation and failed evidence writes cannot establish terminal failure. Once the bridge has recorded a prompt ID or conversation URL, recovery cannot replace it with a different page that happens to contain the same text.

The CLI uses the same management surface:

```sh
dsh-chatgpt-web setup --state-directory /absolute/stateDir/web --provider chatgpt
dsh-chatgpt-web status --state-directory /absolute/stateDir/web
dsh-chatgpt-web verify --state-directory /absolute/stateDir/web
dsh-chatgpt-web enable --state-directory /absolute/stateDir/web
dsh-chatgpt-web turns --state-directory /absolute/stateDir/web
dsh-chatgpt-web inspect --state-directory /absolute/stateDir/web 'turn-<sha256>'
dsh-chatgpt-web recover --state-directory /absolute/stateDir/web 'turn-<sha256>'
dsh-chatgpt-web discard --state-directory /absolute/stateDir/web 'turn-<sha256>'
```

CLI `enable` controls daemon availability; the installed provider still independently checks actual host auxiliary policy and budget before model resolution and dispatch. Tokens are held in owner-only files and are not printed by setup/status or sent to the provider card. Management and model HTTP listeners bind literal loopback and reject browser Origin headers. Handshake acceptance checks private credentials, protocol/package version, instance nonce, physical profile, installation and account binding.

The daemon owns the physical profile before launching Chrome and validates the browser's actual command line. A plugin client releases only its own leases. Idle shutdown waits for all clients, active operations and unresolved outcomes; Chrome cleanup targets only the proven owned process. Missing/changed locks are never reclaimed based on PID alone. After a crash, establish that no owned browser/bridge operation remains and inspect the journals before offline lock repair. There is no automatic lock-stealing or evidence-deletion command. The snapshot journal has a 64 MiB bound; reaching it stops new admission rather than erasing history.

## Validation and release boundary

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run typecheck
npm run verify:client
npm run verify:install
npm run verify:web-agent-loop -- /path/to/stock-dsh --deps /path/to/host-dependencies
npm run verify:web-plugin-host -- /path/to/stock-dsh --deps /path/to/host-dependencies
npx playwright-core install --with-deps chromium
DSH_TEST_CHROMIUM=/absolute/path/to/chromium npm run test:web-browser
```

The dedicated Chrome CI job explicitly enables real browser tests. If Chromium is unavailable or cannot start, that job fails; it does not replace a browser run with mocked page methods. Ordinary offline tests cover exact attachment replay, schema validation, fsync failures, leases, request identity, disposal, independent daemon clients and stock host tool/checkpoint behavior. The separate plugin-host gate activates the actual entry with stock Cordis/Loader/Include/ConfigEditor/LLM and checks awaited cleanup, configuration remounts and nested title-policy discovery.

Before calling this live-accepted, verify with the intended signed-in account: text, one local tool and its follow-up, user/tool-result images, compaction and a fresh Project, provider switching, cancellation, interrupted delivery, DSH/daemon restarts, and two independently disposed clients. Record browser/OS/DSH versions and the resulting journal/session evidence. No current fixture result substitutes for that account-bound acceptance.
