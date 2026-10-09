# Changelog

## 0.1.10

Documentation and metadata only; no behaviour change.

The install section still said the name resolves nothing until the first npm release and sent readers to a
prebuilt tarball. The package has been on npm since 0.1.0 — nine releases earlier — and the tarball it pointed
at was the v0.1.0 GitHub release, so the workaround was both unnecessary and stale. The part worth keeping,
that installing from a repository URL needs a build-script allowlist, is still there.

Also fixes "Two rules the code enforces" over a list of three.

Grouped from the commit history, newest first. Earlier entries are terser than later ones because they were
written when the release was the only record.

## 0.1.9

- fix(errors): stop choosing a cause the endpoint does not give (`141322a`)

## 0.1.8

- fix(errors): say which allowance actually ran out (`bf8fef8`)

## 0.1.7

- docs(request): record the two cache controls this route refuses (`30a5f3b`)
- fix(request): name a cache key, and correct what the readme claimed about caching (`956e0bc`)

## 0.1.6

- test(session): assert what a bare sign-out leaves behind (`dbbaf8b`)
- fix(client): sign out passed no argument to a method that takes one (`ba7488c`)

## 0.1.5

- fix(stream): stop the missing-credential message from saying it twice (`fa37273`)

## 0.1.4

- fix(stream): a dropped connection is transport, not a missing credential (`8b574ce`)

## 0.1.3

- fix(auth): keep the registration when a session ends (`b49dd4e`)

## 0.1.2

- fix(release): the published package could not load (`668cc7a`)

## 0.1.1

- docs: put the words before the pictures (`0becacb`)
- fix(readme): the package page was not this README (`1ccb74e`)

## 0.1.0

- chore(release): keep provenance to the workflow (`cef3dba`)
- feat(release): publish to npm, and document the one-line install (`c0f4ff7`)
- docs: screenshots a storefront can show (`dc6f77c`)
- chore(package): discoverable metadata, and peer ranges that admit prereleases (`e4dd0f9`)
- docs: record why the cache-hit readout is zero on this route (`da82c5f`)
- fix(stream): fix the summary length, and count cache writes (`6c26437`)
- fix(stream): replay assistant turns as output, and ask for a thinking summary (`730499f`)
- fix(stream): report token usage, so the readouts under the composer fill in (`c5de33b`)
- fix(models): tell the browser the roster changed, and report it on the card (`6799134`)
- fix(client): unwrap what a Remote call resolves to (`03884c0`)
- fix(client): read the namespace through ctx.get, and type-check the client half (`7d42b39`)
- fix(client): satisfy the second validator's codec contract (`d7d0e9f`)
- fix(client): mount this plugin's own Remote namespace (`d4e444e`)
- fix(config): make the Config fields volatile, which is what a settings namespace needs (`2c92d68`)
- fix(models): declare a Config schema, without which the provider row is invisible (`acb5819`)
- feat(auth): end the session at the server, and name the page that can help (`f4f8e02`)
- fix(package): put declarations where the manifest says they are (`c2b8f8d`)
- feat(ui): sign in from the Models page (`3b50aef`)
- fix(models): take reasoning levels and capacity from measurement, not the listing (`90b976b`)
- docs: contrast the run-time catalog with pi-ai's bundled one (`e121e8a`)
- docs: record the served roster and the context ceiling (`b41caaf`)
- feat(models): offer the models this route measurably serves (`402dcf8`)
- feat(adapter): report the extended context the endpoint advertises (`9045f1e`)
- fix(models): take the description from the endpoint, and treat the roster as a roster (`85a82b9`)
- docs: note that the catalog is a superset of what an account may call (`9ff2d67`)
- fix(adapter): refuse a model the account does not offer (`29b7a28`)
- fix(plugin): declare the injected service and speak the host's error taxonomy (`f038d4d`)
- feat(plugin): register the provider route, with a bundle layer and typed shims (`3aa1d5b`)
- docs: add the bundle README pair, locale metadata, and license (`7913634`)
- feat(adapter): serve a harness provider route from a ChatGPT plan (`30fb23e`)
- feat(client): call the Responses API with a plan grant (`20611b6`)
- feat(convert): translate harness requests to Responses, and stream to blocks (`eb6c4da`)
- feat(models): describe account models with capacities and reasoning levels (`162136e`)
- feat(api): decode the Responses event stream and its failure modes (`835113e`)
- feat(auth): Sign in with ChatGPT protocol, credentials, and refresh (`7d4eb29`)
