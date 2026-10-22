# @trawlme/n8n-nodes-trawl

An [n8n](https://n8n.io/) community node for [Trawl](https://trawl.me/?utm_source=n8n&utm_medium=integration): run your web scraps and use their results in any workflow.

Trawl turns a website into a scheduled, self-healing scrap. This node lets n8n list your scraps, start a run and read the rows of the last run. It is a thin wrapper over the public Trawl REST API and has no runtime dependencies.

The node can also be used as a tool by the n8n AI Agent.

## Installation

On self-hosted n8n, open **Settings > Community Nodes**, select **Install**, enter `@trawlme/n8n-nodes-trawl` and confirm. On n8n Cloud, community nodes can be installed only once n8n has verified the node.

See the n8n guide: [Install community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

The node uses a **Trawl API** credential:

| Field | Value |
| --- | --- |
| API Key | A Trawl API key, starting with `trawl_`. Create one in the Trawl app, on the **Developers** page. |
| Base URL | `https://api.trawl.me` (default). Change it only to target another Trawl instance. |

The key is sent as `Authorization: Bearer <key>`. n8n checks it with a one-item scrap list.

Scopes the key needs, by operation:

| Operation | Scope |
| --- | --- |
| Credential test and the "From List" scrap picker | `trawl:scraps:read` |
| Get Many | `trawl:scraps:read` |
| Run | `trawl:scraps:run` |
| Get Latest Result | `trawl:scraps:read` and `trawl:history:read` |

No account yet? [Start with Trawl](https://trawl.me/?utm_source=n8n&utm_medium=integration).

## Operations

Resource **Scrap**:

| Operation | What it does | API route |
| --- | --- | --- |
| Get Many | Lists your scraps, with an optional text search. | `GET /api/scraps` |
| Run | Runs a scrap. With **Wait for Result** on (default), the node waits for the run to finish and outputs one item per scraped row (a run can take a few minutes). With it off, the run is queued and the node outputs `{ status: "queued", scrapId }` at once. **Parameters** (optional JSON, default `{}`) are sent with the run. **Output** is `Rows` (default) or `Full Response`. | `POST /api/scraps/worker/:id` (wait) or `POST /api/scraps/worker/:id?wait=false`, both with the Parameters as the body |
| Get Latest Result | Outputs the rows of the scrap's last run, one item per row. It never starts a run and uses no run quota. | `GET /api/scraps/:id`, then `GET /api/historys/:runId` |

Pick the scrap from a searchable list, or paste its ID (24 hex characters).

### Parameters

**Parameters** lets one scrap serve many inputs. Give a JSON object (or an expression that returns one). The keys must match the scrap's stored parameter keys exactly (normally `TRAWL.<name>`), and all of them are required. A mismatch fails the run with a 422. A scrap with no parameters ignores them. With **Wait for Result** off the body is not checked up front, so a wrong key fails the run later. `TRAWL.url` can never be overridden.

```json
{ "TRAWL.city": "Paris", "TRAWL.limit": 20 }
```

Invalid JSON, or a value that is not an object, fails the node with an error naming the field.

### Output

- **Rows** (default): one item per scraped row.
- **Full Response**: one item per call, `{ statusCode, body }`, where `body` is the raw API JSON `{ type, message, data }`. It works like the HTTP Request node with "include status" on and "never error": an HTTP error status (for example a `429` when a run is already in progress) is output, not thrown, so the workflow can branch on `statusCode`. A network error or a timeout still fails the node. Full Response always outputs one item, so the zero-row case of Rows does not apply.

**Get Latest Result** fails with a clear message when the scrap has never run, when a run is still in progress, when the last run failed, or when the stored data of the last run has aged out. A successful run with zero rows outputs nothing, and so does **Run** with zero rows: n8n ends the branch there, so for scheduled flows turn on the node setting **Always Output Data**. Turn on **Continue On Fail** to get the error as an item instead.

## Example workflow

Every morning, run a scrap and post the number of rows to a chat:

1. **Schedule Trigger**: every day at 08:00.
2. **Trawl**: Resource *Scrap*, Operation *Run*, pick your scrap, *Wait for Result* on.
3. Any next node (Google Sheets, Slack, a database, ...) receives one item per scraped row.

To read data that a Trawl schedule already collected, use **Get Latest Result** instead of **Run**: it costs no run.

Import this skeleton with **Import from clipboard**, then select your credential and scrap:

```json
{
  "nodes": [
    {
      "parameters": { "rule": { "interval": [{ "triggerAtHour": 8 }] } },
      "name": "Every morning",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [0, 0]
    },
    {
      "parameters": {
        "resource": "scrap",
        "operation": "run",
        "scrapId": { "__rl": true, "mode": "id", "value": "YOUR_SCRAP_ID" },
        "waitForResult": true
      },
      "name": "Trawl",
      "type": "@trawlme/n8n-nodes-trawl.trawl",
      "typeVersion": 1,
      "position": [220, 0]
    }
  ],
  "connections": {
    "Every morning": { "main": [[{ "node": "Trawl", "type": "main", "index": 0 }]] }
  }
}
```

## Development

```bash
npm ci
npm run lint
npm run build
npm test
npm run dev   # starts a local n8n with the node loaded
```

Releases are automatic and published from GitHub Actions with npm provenance:

- Every merge to `main` runs semantic-release (conventional commits), tags `vX.Y.Z` and publishes to the npm `next` tag (`.github/workflows/release.yml`). `latest` does not move.
- To ship a version to users, run the `Promote` workflow with that version (`.github/workflows/promote.yml`): it moves `latest` to it.
- Never run `npm publish` or `npm run release` by hand. The one exception is the one-time bootstrap described in the `release.yml` header.

## Resources

- [Trawl](https://trawl.me/?utm_source=n8n&utm_medium=integration)
- [Trawl CLI](https://www.npmjs.com/package/@trawlme/cli)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE)
