# Private inference gateway

A CPU-only Node.js/TypeScript gateway in front of an internal Azure Container
Apps GPU model server. Invalid keys are rejected **before any backend request**.
No production npm dependencies.

```text
Coding client --HTTPS/Bearer key--> Public CPU gateway
                                     |
                        authenticate, validate, limit
                                     |
                         HTTPS/separate backend key
                                     v
                           Internal GPU llama.cpp
                           Azure Files model mount
```

## What is implemented

- Constant-time comparison of hashed bearer keys; missing configuration fails startup.
- No backend connection on startup, rejected authentication, health probes, model
  discovery, unsupported routes, invalid JSON, or local limit failures.
- Only `POST /v1/chat/completions` and `POST /v1/completions` forward inference.
- Explicit, authenticated `POST /warmup` checks only the backend `/health`.
  It can wake the GPU but never generates tokens; it shares inference rate and
  concurrency limits. It is never called automatically by local health/discovery.
- `GET /v1/models` requires authentication and returns the configured model locally.
- Public `/healthz` and `/readyz` only check that the gateway is running. They do
  **not** assert that the model is loaded, reachable, or correctly configured.
- Streaming SSE and JSON responses, backpressure, cancellation on disconnect,
  bounded upload and upstream timeouts, no automatic retries, no redirect following.
- Separate backend credentials; client headers, cookies, and backend error bodies
  are not forwarded indiscriminately. No request bodies or keys in application logs.
- Deployed limits: 1 MiB body, three active inference/upload requests, 30 authenticated
  inference attempts per minute, 32768 output tokens (of which at most 8192 are thinking; see
  [Thinking budget](#thinking-budget)). `max_completion_tokens` is normalized
  to `max_tokens`; unbounded values, `n_predict`, and `n > 1` are rejected.
- Non-root Docker image and Bicep for a public CPU app and internal A100 app.
- Pinned **Qwen3.8-27B UD-Q4_K_M (4-bit)** with a **262,144-token context** (the
  model's native maximum), served by three parallel llama.cpp slots that share one
  unified KV cache. [model.json](model.json) is shared by the model downloader and Bicep parameters.
- **MTP speculative decoding** using the model's own multi-token-prediction draft head
  (`mtp-Qwen3.8-27B-Q4_0.gguf`, about 1.37 GB, pinned in [model.json](model.json)).
  On by default; it speeds up token generation only. See
  [Turning MTP on or off](#turning-mtp-speculative-decoding-on-or-off).
- Workflow-time model transfer from Hugging Face into Azure Files, using bounded
  4 MiB ranges, exact size/SHA-256 verification, and a verified-file cache.
- Optional **ingress IP allowlist** and a configurable **VRAM layer limit**, so the
  deployment can be locked to your own address and made to approximate a smaller GPU.

The 262,144-token context includes input and output and is a shared pool: any one
request can use all of it, but concurrent requests compete for it. Full-context inference memory
and prompt latency still need a live test. The gateway's 1 MiB body limit, 32768-output-token
limit, and idle-based upstream timeout apply; large prompts will hit
these limits well before filling the model's context window.

This is a focused OpenAI **Chat Completions/Completions** proxy, not the entire
OpenAI API. Responses API, embeddings, file uploads, image generation, WebSockets,
model administration, and browser CORS access are not enabled. Tool-call JSON can
pass through, but the gateway never executes tools. Start with text-only coding;
the provided model configuration does not load a vision projector.

## Local development

Requires Node.js 22+ and npm.

```powershell
npm ci
npm test
npm run check
```

The integration tests start local mock model servers, not Azure. They assert the
backend request count stays **exactly zero** for rejected requests and local
health/discovery calls. They also verify actual progressive SSE delivery,
credential replacement, size/rate/concurrency limits, timeouts, and cancellation.

To run against your own llama.cpp server:

1. Copy `.env.example` to `.env`.
2. Replace both example keys with different cryptographically random secrets.
3. Set `BACKEND_URL` to the server origin, without `/v1`. Use the same backend key
   in llama.cpp's `LLAMA_API_KEY`.
4. Build and start:

```powershell
npm run build
node --env-file=.env dist\src\index.js
```

Generate a key locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Do not paste keys in chat, commit them, or put them in browser JavaScript.
All settings and defaults are in [.env.example](.env.example).

The gateway listens on all interfaces for container compatibility. For local
Docker usage, bind only loopback: `-p 127.0.0.1:8080:8080`. Local plain HTTP is for
loopback development only; Azure ingress is HTTPS-only.

## What this costs

Serverless GPU apps bill per second for **three** meters at once, not just the GPU.
The container must request the whole workload profile, so the vCPU and memory
charges are fixed and together cost more than the GPU itself.

Rates below are Azure retail pay-as-you-go for **West US 3 in USD, retrieved
2026-10-11**, excluding tax. Check
[Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)
for your own region and currency.

| Meter | A100 profile (24 vCPU, 220 GiB) | T4 profile (8 vCPU, 56 GiB) |
| --- | --- | --- |
| GPU | $1.904/hour | $0.263/hour |
| vCPU | $2.074/hour | $0.691/hour |
| Memory | $2.376/hour | $0.605/hour |
| **While a replica runs** | **$6.35/hour** | **$1.56/hour** |

A replica runs while it serves requests **and** through the 600-second idle
cooldown that follows. Serverless GPU replicas are always billed at the active
rate; the reduced idle rate never applies to them. At zero replicas, compute
costs nothing.

| Usage | A100 | T4 |
| --- | --- | --- |
| One 8-hour session, plus one cooldown | about $52 | about $13 |
| 8 hours a day, 22 days | about $1,140 | about $280 |
| Three evaluation days | about $156 | about $38 |

Storage and registry continue at roughly **$6 a month** even when nothing runs:
Azure Files holds the ~17.9 GB of weights at $0.06/GB per month (about $1.07),
and the Basic registry costs $0.1666 a day (about $5.07). Each subscription also
gets 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests free each
month, which covers roughly the first two hours of vCPU on the A100 profile.

**This is a test-drive tool, not a cheap daily driver.** A few days of evaluation
costs tens of dollars, a small fraction of any GPU purchase. But 8 hours every
weekday costs about $1,140 a month on the A100 profile, so a high-end consumer card
would pay for itself in roughly two months. Cold starts are billed too: every
wake-up reloads ~17.9 GB from Azure Files before serving.

Costs here are observed and estimated, not a quote. Watch real spend in
**Cost Management**, and see [Limiting what a stolen key can spend](#limiting-what-a-stolen-key-can-spend).

## Azure deployment

**Nothing is deployed just by building or testing this project.** The commands
below create billable resources. Review the pricing and template before running.
Local tests do not prove Azure ingress, scaling, or inference behavior. Validate
the deployed environment using the live checks below.

### Prerequisites

- Azure CLI with Bicep and permissions to deploy resources, assign the AcrPull role,
  build images, and access the file share.
- An environment dedicated to trusted apps: other apps inside the environment can
  reach the internal model ingress. No public environment HTTP route may target
  the model app. Network isolation of internal ingress is essential; a backend key
  by itself does not prevent direct requests from waking the GPU.

If you already have a workload-profiles environment with a
**Consumption-GPU-NC24-A100** profile, skip to
[step 1](#1-bootstrap-registry-and-model-storage). Otherwise start from scratch below.
The template needs the actual *profile name*, not its type. Never use a dedicated
NC24-A100 profile if scale-to-zero billing is required.

### 0. Create the environment and GPU profile

Starting from nothing but a subscription:

```powershell
az login
az account set --subscription '<subscription-id>'
az extension add --name containerapp --upgrade

foreach ($ns in 'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights') {
  az provider register --namespace $ns
}
```

Registration runs in the background and takes a few minutes. Check it with
`az provider show --namespace Microsoft.App --query registrationState -o tsv`
until it reports `Registered`.

Pick a region that offers the GPU you want. A100 and T4 are both available in
**West US 3**; see
[serverless GPU regions](https://learn.microsoft.com/azure/container-apps/gpu-serverless-overview#supported-regions)
for the rest. Create the resource group and a **workload profiles** environment,
which serverless GPUs require. A Consumption-only environment cannot host them.

```powershell
$rg = '<resource-group>'
$env:AZURE_LOCATION = 'westus3'
$env:ACA_ENVIRONMENT = '<new-environment-name>'

az group create --name $rg --location $env:AZURE_LOCATION
az containerapp env create --name $env:ACA_ENVIRONMENT --resource-group $rg --location $env:AZURE_LOCATION --enable-workload-profiles
```

Now confirm GPU quota **before** adding the profile. Pay-as-you-go and enterprise
agreements usually have A100 and T4 quota already; credit-based subscriptions such
as Visual Studio or free trials often have none, and a request can take days.

1. Open the environment in the Azure portal and select **Quota**.
2. Look for **Managed Environment Consumption NCA100 GPUs** (or **T4 GPUs**).
3. If the quota is zero, request an increase and wait for approval. See
   [managed environment quota requests](https://learn.microsoft.com/azure/container-apps/quota-requests#submit-a-managed-environment-quota-request).

If the GPU quota is missing from that page entirely, the region or environment type
does not support serverless GPUs. Once quota exists, add the profile and note its name:

```powershell
$env:GPU_PROFILE_NAME = 'gpu-a100'
az containerapp env workload-profile add --name $env:ACA_ENVIRONMENT --resource-group $rg `
  --workload-profile-name $env:GPU_PROFILE_NAME --workload-profile-type Consumption-GPU-NC24-A100
az containerapp env workload-profile list --name $env:ACA_ENVIRONMENT --resource-group $rg -o table
```

Use `Consumption-GPU-NC8as-T4` instead for the cheaper 16 GB card. The listing must
show both your GPU profile and the default `Consumption` profile; the gateway runs on
the latter. Adding a profile costs nothing until a replica runs.

Then continue with the resource names used by the rest of this guide:

```powershell
$env:ACR_NAME = '<globally-unique-registry-name>'
$storage = '<globallyuniquelowercasestorage>'
```

### 1. Bootstrap registry and model storage

For GitHub Actions, this step is automated on every manual deployment.
Leave **bootstrap_only unchecked** to bootstrap, download/verify the model, and
deploy both apps in one run. Check it only to provision infrastructure without
transferring the model or deploying apps. The commands below are an alternative
for running bootstrap locally.

[infra/bootstrap.bicep](infra/bootstrap.bicep) creates:

- Basic Azure Container Registry with admin password disabled.
- A user-assigned identity with AcrPull scoped to that registry.
- A dedicated Standard LRS storage account and classic SMB share `models`.
- A read-only environment storage definition `qwen-models`.

It does not replace or recreate your environment. ACR and storage have ongoing
costs even at zero replicas. This small setup uses a shared storage account key for
the SMB mount, kept in the environment configuration, not application variables.
Only use a dedicated model storage account; restrict who can read environment
configuration. Storage network access is public but authenticated, not anonymous.
Private endpoints/firewall rules require environment-specific networking and are
not added by this starter.

```powershell
az deployment group what-if --resource-group $rg --template-file .\infra\bootstrap.bicep --parameters environmentName=$env:ACA_ENVIRONMENT location=$env:AZURE_LOCATION registryName=$env:ACR_NAME storageAccountName=$storage
az deployment group create --resource-group $rg --template-file .\infra\bootstrap.bicep --parameters environmentName=$env:ACA_ENVIRONMENT location=$env:AZURE_LOCATION registryName=$env:ACR_NAME storageAccountName=$storage
```

The workflow automatically transfers `Qwen3.8-27B-UD-Q4_K_M.gguf` from
[the Unsloth repository](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) using
the immutable revision, size, and SHA-256 recorded in [model.json](model.json).
This is the **dynamic** Q4_K_M variant, approximately 16.46 GB (15.33 GiB).
The same pinned revision's `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` draft head (about
1.37 GB) is transferred and verified the same way and stored at the share root as
`mtp-Qwen3.8-27B-Q4_0.gguf`.
Review its license and source before deployment. The files never pass through
your computer or get fully buffered on the runner's disk.

For a local CLI deployment, you can either upload both files manually to the root
of the `models` share or invoke the same downloader after bootstrap:

```powershell
npm ci
npm run build
$env:STORAGE_ACCOUNT_NAME = $storage
try {
  $env:AZURE_STORAGE_KEY = az storage account keys list --resource-group $rg --account-name $storage --query '[0].value' -o tsv
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read storage credential' }
  node .\dist\scripts\download-model.js
  if ($LASTEXITCODE -ne 0) { throw 'Model transfer failed' }
} finally {
  if (Test-Path Env:\AZURE_STORAGE_KEY) { Remove-Item Env:\AZURE_STORAGE_KEY }
}
```

Running that command **locally** uses your machine's bandwidth. Prefer GitHub
Actions to keep the transfer off your computer. To change the model in the
workflow, update the manifest's filename, revision, size, and hash together,
including the `mtp` entry (`sourcePath` is its path inside the Hugging Face repository).
Changing `MODEL_IMAGE` changes only the serving runtime, not the weights.

**Complete the upload before deploying the GPU app.** The app loads from
`/models` and never downloads weights at startup. Azure Files throughput can
dominate cold-start time. The read-only mount avoids modifying the model from
inside the container, but does not protect against a storage administrator
replacing it.

### 2. Build the gateway image

Azure ACR Tasks can build it without local Docker:

```powershell
$env:GATEWAY_IMAGE = & .\scripts\build-gateway.ps1 -Registry $env:ACR_NAME -ResourceGroup $rg -Tag v1
```

Stop on any CLI failure; do not continue with empty output variables.
Registry role assignments may take a few minutes to propagate before the
gateway can pull its image.

The build script waits for ACR Tasks to finish and reads the exact image digest
from that run's `outputImages` management-plane metadata. It does not call
`az acr repository show`, which requires separate registry data-plane access and
can fail even after a successful build/push. Registry admin login stays disabled.
Build logs are available with `az acr task logs --registry <registry> --run-id <run-id>`;
the script prints the completed run ID.

Choose a tested official
[llama.cpp CUDA 12 server image](https://github.com/ggml-org/llama.cpp/blob/master/docs/docker.md)
compatible with this model, and pin its digest:

```powershell
$env:MODEL_IMAGE = 'ghcr.io/ggml-org/llama.cpp@sha256:<digest-for-server-cuda>'
```

If Docker is available, `docker buildx imagetools inspect ghcr.io/ggml-org/llama.cpp:server-cuda`
shows the current digest. Do not copy the placeholder above unchanged.
Pinning is not a substitute for applying tested security updates.

MTP speculative decoding needs a llama.cpp build that has `draft-mtp` and the
`LLAMA_ARG_SPEC_TYPE`/`LLAMA_ARG_SPEC_DRAFT_MODEL` settings (added from May 2026,
starting with ggml-org/llama.cpp#22673). With an older image, deploy with
`MTP_ENABLED=false` or update the digest. The model app runs llama-server through
a small `/bin/sh` wrapper, so the image must keep the official `/app/llama-server` path.

### 3. Set distinct secrets and deploy both apps

Create and retain two different random keys in your password manager. Set
`GATEWAY_API_KEY` and `BACKEND_API_KEY` in your current shell without typing their
literal values into command history. For example, PowerShell can prompt:

```powershell
function Read-SecretText([string] $prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $credential = New-Object System.Net.NetworkCredential('', $secure)
  return $credential.Password
}
$env:GATEWAY_API_KEY = Read-SecretText 'Client API key (32+ random characters)'
$env:BACKEND_API_KEY = Read-SecretText 'Different backend API key (32+ random characters)'
```

[infra/main.bicepparam](infra/main.bicepparam) reads these shell variables.
Parameters are marked secure in Bicep. Do not run `build-params` with real keys
and save the resulting JSON; it would contain those keys. Avoid CLI debug logs.

```powershell
az deployment group what-if --resource-group $rg --parameters .\infra\main.bicepparam
az deployment group create --resource-group $rg --parameters .\infra\main.bicepparam
```

The main template creates apps named `qwen-gateway` and `qwen-model`. If resources
already have those names, inspect them first; applying this template updates their
configuration. It **does not** modify your previously created temporary quickstart
app. Delete that temporary app separately after confirming it is no longer needed.

Keep keys in the shell only as long as necessary. After deployment and testing:

```powershell
Remove-Item Env:\GATEWAY_API_KEY, Env:\BACKEND_API_KEY
```

The CPU app has a registry-pull identity only, with no model-storage access.
The model has no Azure managed identity. Both app replicas are bounded 0..1.
First deployment can start replicas to check readiness, so deployment itself can
incur GPU charges even before the first user request.

### 4. Verify the actual security boundary

Do not treat a passing local test as proof of Azure ingress/scaling behavior:

1. Check the model app ingress is **Limited to Container Apps Environment** and
   no environment-level public route targets it. Verify its direct URL is not
   reachable from your Mac.
2. Confirm gateway and GPU use different workload profiles.
3. Wait for the model's replica metric to reach **zero**.
4. Send missing/incorrect keys to gateway inference and check for `401`.
5. Call `/healthz`, `/readyz`, and authenticated `/v1/models`.
6. Confirm the **model replica count stayed zero** throughout these requests.
7. Run the authenticated warmup below and observe the model wake and CUDA load.
8. Send an authorized chat request, verify a streamed response, then confirm the
   model eventually scales down after the idle cooldown.

Example request after obtaining the gateway domain from deployment outputs:

```powershell
$base = 'https://<gateway-domain>'
$headers = @{ Authorization = "Bearer $env:GATEWAY_API_KEY" }
Invoke-RestMethod "$base/v1/models" -Headers $headers
$env:GATEWAY_BASE_URL = "$base/v1"
node .\scripts\warmup.mjs
if ($LASTEXITCODE -ne 0) { throw 'Model warmup failed; inspect logs before sending inference' }
$body = @{
  model = 'qwen3.8-27b'
  messages = @(@{ role = 'user'; content = 'Write a TypeScript sum function.' })
  max_tokens = 256
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

Your coding client uses base URL `https://<gateway-domain>/v1`, the **gateway**
key, and model `qwen3.8-27b`. Never configure a client with the backend key.

### Warm up before a coding session

After an idle scale-down, run [scripts/warmup.mjs](scripts/warmup.mjs) with
`GATEWAY_BASE_URL=https://<gateway-domain>/v1` and `GATEWAY_API_KEY` in the
environment. This works from your Mac or Windows with Node.js 22+. Do not put
the key in command arguments or commit it to a file.

The script sends authenticated `POST /warmup` requests with JSON `{}` and waits
up to **9 minutes**. Each backend health request is capped at **10 seconds**:

- `200 {"status":"ready"}` means the backend health endpoint returned HTTP 200.
- `202 {"status":"warming"}`, with `Retry-After: 5`, means health is still
  unavailable (HTTP 502/503/504 or timeout). This is not a successful startup.
- Authentication, unexpected responses, network failures, and the overall
  deadline fail explicitly. Inspect logs rather than retrying indefinitely.

Warmup is an intentional, billable GPU activation. It does not submit inference,
keep the model running indefinitely, grant Azure management access, or increase
minimum replicas. Invalid keys/bodies and unsupported route variants never
contact the model. The existing `/healthz`, `/readyz`, and `/v1/models` remain
entirely local.

The model's **600-second idle cooldown** gives multi-minute initialization time
to finish even between bounded warmup requests. It also keeps a loaded replica
billable for roughly 10 idle minutes; platform scheduling can affect the exact
scale-down time. Minimum/maximum replicas remain **0/1**. Re-run warmup after
another idle scale-down. Coding clients do not automatically call this custom
endpoint: warm the model before connecting/sending their first inference.

The gateway's **210-second inference deadline is unchanged**. A cold request may
outlast it; increasing a single request beyond Container Apps' HTTP ceiling is
not a reliable fix. Warmup handles startup separately without replaying prompts.
A successful health check proves loading, not full-context inference quality
or tool-call compatibility.

## GitHub Actions deployment

[.github/workflows/azure.yml](.github/workflows/azure.yml) runs tests and compiles
Bicep on pushes and pull requests. **Only a manual workflow run from the default
branch deploys**, after validation succeeds and any `production` environment
approvals are granted. Pull requests receive no Azure identity or inference keys.

The workflow first applies **bootstrap.bicep** to create/update the registry,
model storage, read-only mount, and pull identity. It then downloads/verifies the
pinned GGUF if needed, builds the **gateway** with ACR Tasks, resolves its digest, and uses
the main Bicep template to deploy **both apps**. The model app uses your pinned
official llama.cpp CUDA image. Its GGUF weights stay in Azure Files; Actions does
not rebuild the model runtime. A valid verification receipt skips model transfers
on later deployments.
ACR Tasks performs the Linux image build remotely from the Windows runner, so
Docker does not need to be installed on the runner.

### One-time prerequisites

1. Put this project in a GitHub repository. The workflow must be on the repository's
   default branch before **Run workflow** is available.
2. Choose globally unique registry and storage account names and configure the
   GitHub environment settings below. If bootstrap was previously run locally,
   use those same names so the workflow reuses the existing resources.
3. Verify A100 quota, the CPU Consumption profile, and the named serverless A100
   profile. Verify the image digest really refers to `server-cuda`, not a CPU or
   macOS image; the workflow can validate digest syntax, not runtime compatibility.
4. Create a GitHub environment named **`production`** under repository
   **Settings -> Environments**. Restrict deployment branches to your default
   branch and enable required reviewers where your GitHub plan supports them.
5. Set up Azure OIDC as described below. Do not create a long-lived Azure client secret.

Bootstrap is now automatic, so the deployment identity **also needs permission
to create the AcrPull role assignment**, in addition to Contributor. Azure login,
OIDC trust, initial role grants, the resource group, and the Container Apps
environment must already exist; a workflow cannot grant itself these permissions.
The main template manages apps called `qwen-gateway` and
`qwen-model`; it will overwrite settings on existing apps with these names.
Review changes before approval, including any portal-configured IP restrictions
that aren't represented in the template.

### Azure OIDC identity

Follow [Microsoft's GitHub-to-Azure OIDC guide](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)
to create an Entra application/service principal or a user-assigned managed
identity. Use a **separate deployment identity**, not the gateway's AcrPull
runtime identity.

Configure its federated credential for:

| Field | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:YOUR-OWNER/YOUR-REPO:environment:production` |
| Audience | `api://AzureADTokenExchange` |

The subject uses the **environment**, not `ref:refs/heads/main`, because this
workflow's deployment job declares `environment: production`.

For this starter, grant the deployment identity:

- **Contributor**, scoped to the dedicated resource group.
- **Role Based Access Control Administrator**, scoped to that same group, for
  bootstrap's AcrPull assignment. Where practical, constrain its role-assignment
  conditions to the AcrPull role and the intended pull identity. This permission
  is powerful; protect the production environment and require approval.

Contributor alone cannot create role assignments. An Azure administrator must
grant these permissions before the first workflow run. Do not grant subscription
Owner. With the bootstrap registry's standard RBAC mode, Contributor covers the
resource deployment, ACR Tasks build/run reads, and storage key retrieval.
A custom least-privilege role can narrow this further; it must
retain deployment validation/write, app and environment access, managed-identity
assignment, and the registry build/read operations. ABAC-enabled registries need
different repository permissions and are not the bootstrap configuration.

### GitHub production environment settings

Add these **environment variables** (not secrets):

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Deployment identity's client/application ID |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription ID |
| `AZURE_RESOURCE_GROUP` | Resource group containing the existing environment |
| `ACA_ENVIRONMENT` | Existing Container Apps environment name |
| `ACR_NAME` | Registry name, without `.azurecr.io` |
| `STORAGE_ACCOUNT_NAME` | Globally unique model storage account name: 3-24 lowercase letters/digits |
| `GPU_PROFILE_NAME` | Existing profile name whose type is `Consumption-GPU-NC24-A100` |
| `MODEL_IMAGE` | `ghcr.io/ggml-org/llama.cpp@sha256:<64-character-digest>` for the CUDA server |
| `MTP_ENABLED` | Optional. `true` (default when unset) or `false`; the MTP setting each deployment applies |
| `THINKING_BUDGET_TOKENS` | Optional. Thinking-token cap each deployment applies: `8192` when unset, `-1` for unlimited |
| `GPU_LAYERS` | Optional. Layers kept in VRAM: `all` when unset, `auto`, or an exact count for smaller-GPU testing |
| `ALLOWED_CLIENT_IPS` | Optional. Comma-separated CIDR allowlist for the gateway; unset means any address may reach it |

Add these **environment secrets**:

| Secret | Value |
| --- | --- |
| `GATEWAY_API_KEY` | Your random client key, at least 32 characters |
| `BACKEND_API_KEY` | A different random backend key, at least 32 characters |

For a bootstrap-only run, `GPU_PROFILE_NAME`, `MODEL_IMAGE`, and the two API-key
secrets are not needed yet. Set them before the first full deployment.

The environment's region is discovered automatically. Keys are exposed only to
steps that need them, not to the ACR build step. No real-key parameter JSON or
deployment artifact is published. Never enable shell tracing or CLI debug output
on secret-handling steps. The workflow uses secure Bicep parameters, but Azure and
GitHub administrators with sufficient permissions remain trusted.

### Deploy and verify

For the first deployment:

1. Open **Actions -> Validate and deploy inference apps -> Run workflow**.
2. Select the default branch and leave **bootstrap_only unchecked**. Approve
   production deployment if requested.
3. The run creates the registry/storage/identity, transfers and verifies the
   pinned 4-bit model, builds the gateway, and deploys both apps.

If you only want infrastructure first, check **bootstrap_only** instead; no model
transfer, image build, app deployment, or smoke test runs. Once app variables and
secrets are ready, run again with that option unchecked. Manual uploading is no
longer required.

Subsequent runs normally leave **bootstrap_only unchecked**. Bootstrap is
repeatable with the same resource names: it reconciles the template configuration
without uploading or deleting the GGUF. It can overwrite manual changes to
managed resource settings. Keep the names stable to avoid creating another
registry/account. Old model files (including previous Q6 weights) are not deleted.

### Model transfer safety and costs

- [scripts/download-model.ts](scripts/download-model.ts) streams from the pinned
  Hugging Face revision into a unique `.partial` file in Azure Files. It does not
  allocate the entire model in memory or download it to the runner's disk.
- Uploads use sequential ranges of at most **4 MiB**, with per-range transport
  MD5 checks and whole-source SHA-256/size verification. Only after all bytes
  verify does it rename the temporary file to the final filename, without
  replacing an existing destination.
- A small `.verified.json` receipt records the source revision/hash, size, and
  Azure file ETag. Matching receipt and file properties allow subsequent runs to
  skip the transfer. Missing/stale receipts trigger streaming verification of
  the existing Azure file; changed or corrupt files fail rather than being
  silently overwritten. A manually uploaded file is verified this way once.
- Storage administrators can alter both a file and its receipt; they remain
  trusted. The receipt is a cache optimization, not a cryptographic signature.
- On transfer failure, only that run's temporary files are cleaned up, and
  **app deployment is blocked**. Azure SDK requests have bounded retries; there
  is no whole-transfer resume. Rerun to retry from the beginning.
- Cancellation can leave a uniquely named `.partial` file, which is never used
  for inference. Remove stale partials after verifying no transfer is running.
  Cleanup failures are logged explicitly. Bootstrap and any previously deployed
  apps remain; a failed run does not shut down old GPU replicas.
- The storage account key is captured/masked in the transfer step, passed only
  through its environment, and cleared afterward. It is not sent to Hugging Face
  or saved in Actions outputs. Signed source URLs and raw SDK errors are not logged.
- The transfer uses GitHub runner time and Azure Files transactions/storage,
  not your computer's bandwidth or a GPU. Reverification of an existing file
  downloads its bytes from Azure and may incur egress charges.
- The transfer has a 90-minute deadline (100-minute step limit); the deployment
  job has a 180-minute limit. Neither is an inference timeout: inference still
  has the gateway's 210-second total deadline.

Bootstrap-only does not deploy or start GPU apps, but **does not stop existing
apps** either. Registry/storage charges apply. It still needs the existing
Container Apps environment, but does not require GPU quota/profile readiness
until a full app deployment.

The deployment job is serialized and does not cancel an active deployment.
It creates uniquely named revisions of **both** apps on every run, even when the
model image stays the same, so changed API keys are loaded consistently. This
can restart the model, cause a brief interruption, and incur GPU initialization
charges. Cancellation or failure is not an automatic rollback.

After deployment, it verifies internal model/public gateway ingress, HTTPS-only
access, replica limits, the expected latest revisions, and gateway revision
readiness. It then runs
[scripts/smoke.mjs](scripts/smoke.mjs):

- Gateway-local health and readiness.
- Authenticated model discovery.
- Missing/invalid credentials rejected with `401` on a deliberately unsupported
  path, so even an authentication regression cannot make this check send inference.

The workflow then runs [scripts/warmup.mjs](scripts/warmup.mjs) and
[scripts/verify-model-ready.ps1](scripts/verify-model-ready.ps1). Deployment
succeeds only after backend health responds successfully and the **exact deployed
model revision** is active, reports `Healthy`, and has a running replica.
`latestReadyRevisionName` alone is not sufficient: Azure can populate it before
the model has loaded. Warmup and revision polling each have a nine-minute bound;
the combined step has a 20-minute hard limit.

The Actions summary contains both image digests but not the gateway base URL or
keys, because run summaries are publicly readable in public repositories. Get
the URL with
`az containerapp show --name qwen-gateway --resource-group <resource-group> --query properties.configuration.ingress.fqdn -o tsv`
and append `/v1`. No inference request is sent, but **full deployments now deliberately wake
the GPU to verify startup**, followed by the billable idle cooldown. Bootstrap-only
still skips this check. A failed check does not disable scale-to-zero or leave
a minimum-one override; it also does not immediately stop an existing replica.
Actual model inference, direct-ingress isolation,
absence of public environment routes, and observed zero replicas during rejected
traffic still require the live checks in Azure deployment step 4.

GitHub-hosted runners must be able to reach the public gateway for smoke checks.
If you apply IP restrictions or private networking, use an appropriately placed
self-hosted runner or allowed egress; do not remove protections just to pass CI.
If a new revision is not ready, inspect Azure logs before rerunning. A failed
workflow may leave billable resources running; investigate rather than assuming
failure stopped them.

## Limits, costs, and operations

- This architecture protects the GPU from requests **rejected by this gateway**,
  assuming there is no alternate public route. It is not a DDoS protection service.
  Invalid traffic can still run the CPU gateway and generate log/ingress charges.
  See [Limiting what a stolen key can spend](#limiting-what-a-stolen-key-can-spend).
- In-memory limits are per gateway process and reset on restart. They are not
  durable quotas or a hard spending cap. With additional replicas or overlapping
  revisions, aggregate limits increase. A stolen valid key can keep one A100 busy.
- Backend readiness probes are local to the GPU replica; the gateway never probes
  it automatically. Only explicit authenticated warmup requests check backend
  health. Scaling cooldown is platform-controlled and GPU charges continue while
  a replica remains running, including idle and initialization time.
- Serverless GPU Consumption is **billed per second**, not rounded up to a whole
  hour. An hourly price is a rate, not an obligation to pay a full hour per start.
  Keeping `minReplicas: 1` incurs continuing compute charges; retain zero for
  intermittent use. Storage, ACR, logging, and other resources can still cost
  money at zero GPU replicas. See the
  [serverless GPU billing overview](https://learn.microsoft.com/azure/container-apps/gpu-serverless-overview).
- The upstream timeout is **idle-based**: a response is cut after 210 seconds without
  a byte, not after a fixed total duration, so a steadily streaming answer may run for
  many minutes. A separate 30-minute total cap bounds a stream that never ends. This
  matches Container Apps ingress, which measures idle time rather than wall-clock
  duration (see [Request timeouts](#request-timeouts)). **Long generations require
  `stream: true`**; a non-streamed response sends nothing until it is complete, so it
  is bounded by the idle limit. A long model load can still outlast that limit.
  A `504` does not prove the GPU stopped. This gateway
  never retries inference automatically; run warmup and then retry manually. If
  multi-minute cold starts are frequent, reconsider this
  synchronous serverless architecture (warm service or an asynchronous job API).
- If a stream fails after headers were sent, the connection is terminated rather
  than returning a false successful completion. Clients must handle interruptions.
- HTTP redirects and unapproved paths are never forwarded. The model origin is
  fixed by an administrator; request content cannot choose an upstream URL.
- Keep client-side coding-agent tool permissions and command approvals enabled.
  This gateway does not make model-generated commands safe.
- Pin/update container images, protect storage and Azure administration access,
  and rotate both keys on exposure. Secret changes require restarting/revising
  affected apps to reload environment variables. Backend rotation needs
  coordination between the two apps and can briefly interrupt service.
- Azure Files, ACR, monitoring, egress, and running replicas can all cost money.
  Budget alerts notify; they do not stop spending. Deactivate model revisions
  or delete the model app when not needed; do not delete unrelated resources.
- Check gateway structured logs for `request_failed`, `upstream_rejected`,
  `client_disconnected`, and `inference_complete`; use request IDs, not sensitive
  prompts, for correlation. `client_disconnected` means the caller hung up, which is
  routine when a coding client cancels a request; it is not a model or gateway fault.
  Inspect llama.cpp and platform logging separately for prompt/privacy exposure.

### Limiting what a stolen key can spend

`maxReplicas: 1` on the model app is the single most valuable control, but it caps
the **rate** of spending, not the total. It guarantees only one A100 can ever run, so
a leaked key cannot scale the GPU out. A key used continuously still costs roughly
**$6.35 an hour, about $4,600 a month**, and the 600-second cooldown keeps the GPU
billable for ten minutes after each request. The rate limit of 30 requests a minute
and three concurrent requests barely slow this down, because one long streaming
request already keeps the GPU fully busy.

The in-gateway limits cannot act as a spending cap: they live in memory, the gateway
scales to zero, and every restart resets them. Real limits have to come from Azure.

**An IP allowlist is the strongest control for personal use**, because rejected
callers never reach the gateway or wake the GPU. Set `ALLOWED_CLIENT_IPS` to a
comma-separated list of CIDR ranges, as a GitHub variable or before a CLI deployment:

```powershell
$env:ALLOWED_CLIENT_IPS = "$(Invoke-RestMethod 'https://api.ipify.org')/32"
```

Any allow rule denies every other address at the ingress. Leaving it unset means
only the API key stands between the internet and the GPU. Re-run the deployment after
your home address changes, and remember that GitHub-hosted runners must still reach
the gateway for smoke checks.

Also worth doing:

- **Set a budget with an alert** in Cost Management. Alerts only notify; to actually
  stop spending, attach an action group that disables the model app.
- **Shorten the idle cooldown** if sessions are bursty. Every wake-up pays up to ten
  idle minutes at the full active rate.
- **Stop the app when you are done evaluating**:
  `az containerapp update --name qwen-model --resource-group $rg --min-replicas 0 --max-replicas 0`
  blocks all inference while keeping the deployment. Set `--max-replicas 1` to resume.
- **Rotate both keys** on any suspicion of exposure, and check the gateway logs for
  `inference_complete` entries you did not cause.

### Testing a smaller GPU

The A100 has 80 GB of VRAM, far more than any consumer card, so a model that runs
here will not necessarily run on hardware you are considering. Two ways to narrow
the gap:

**Use the T4 profile for a real 16 GB test.** Deploying on
`Consumption-GPU-NC8as-T4` gives a genuine 16 GB card for about a quarter of the
price. This is the honest way to check whether a 16 GB consumer GPU suffices, though
Qwen3.8-27B at 4-bit needs roughly 20 GB and will not fit; point
[model.json](model.json) at a smaller model first.

**Limit layers kept in VRAM.** `GPU_LAYERS` maps to llama.cpp's
`LLAMA_ARG_N_GPU_LAYERS`: `all` (default), `auto`, or an exact count. Layers beyond
that count run on the CPU, so VRAM use falls roughly in proportion.

```powershell
az containerapp update --name qwen-model --resource-group $rg --set-env-vars LLAMA_ARG_N_GPU_LAYERS=40
```

Read what the model actually used rather than trusting an estimate. The startup log
reports each buffer size and the KV cache, and `nvidia-smi` in the portal's
**Console** tab shows live VRAM for the replica.

Two honest caveats. This lowers VRAM use but does not cap it: nothing stops llama.cpp
from allocating more, so it answers "how much does this configuration need" rather
than "what happens on a 12 GB card". And offloaded layers here run on 24 server-class
cores with 220 GiB of RAM, so the speed you measure will beat a desktop that spills to
system memory. Treat capacity as representative and speed as an upper bound.

### Turning MTP speculative decoding on or off

The model app reads one flag, `MTP_ENABLED` (`true`/`false`), when its container
starts. A wrapper turns it into llama.cpp's `LLAMA_ARG_SPEC_TYPE=draft-mtp` and
`LLAMA_ARG_SPEC_DRAFT_MODEL` settings, which must be set or cleared together.
Current llama.cpp ignores per-request speculative settings, so the gateway cannot
switch MTP per request.

Flip it without running the workflow, rebuilding, or re-downloading anything:

```powershell
az containerapp update --name qwen-model --resource-group $rg --set-env-vars MTP_ENABLED=false
# Turn it back on:
az containerapp update --name qwen-model --resource-group $rg --set-env-vars MTP_ENABLED=true
```

Each change creates a new model revision and **restarts the GPU container**: the
next request is a cold start, so run warmup afterward. The model log shows
`MTP speculative decoding: enabled` or `disabled` at startup, and llama.cpp logs
`draft acceptance = ...` after each request when MTP is active.

The next workflow deployment reapplies the `MTP_ENABLED` GitHub variable (unset
means `true`). Set that variable too if the change should persist.

MTP only speeds up token generation. It does not change cold starts or prompt
processing, and gains depend on how often drafts are accepted. Turn it off if
outputs or stability regress, or if the model fails to start after an image change.

### Thinking budget

Qwen3.8 thinks before answering, and thinking tokens count toward the output
limit. Without a cap, long thinking can use the whole limit and leave a truncated
answer or tool call. llama.cpp's `LLAMA_ARG_THINK_BUDGET` (default **8192**) stops
thinking after that many tokens, adds a short note, and makes the model answer.
With the gateway's 32768-token output limit, at least 24576 tokens remain for the answer.

The budget is a real behavioral limit, not just a length cap. Thinking that is cut
off mid-analysis is **discarded entirely**: the chat template strips prior thinking
from history, so reasoning that never reached visible output cannot inform the next
turn. A model interrupted before it reaches a decision can therefore repeat the same
truncated analysis and the same unproductive action on every turn. `LLAMA_ARG_THINK_BUDGET_MESSAGE`
is the only mechanism that converts about-to-be-discarded reasoning into durable
context, so it asks for a short summary plus one concrete step rather than an
immediate answer. Keep it to one or two sentences: the model cannot reason about
it, because thinking is already closed when it is injected.

Keep the budget finite. Unlimited thinking (`-1`) combined with a large output limit
lets a single turn think for many minutes while producing nothing visible.

Change it without running the workflow (restarts the GPU container; run warmup afterward):

```powershell
az containerapp update --name qwen-model --resource-group $rg --set-env-vars LLAMA_ARG_THINK_BUDGET=2048
# Unlimited thinking (not recommended with a large output limit):
az containerapp update --name qwen-model --resource-group $rg --set-env-vars LLAMA_ARG_THINK_BUDGET=-1
```

The next workflow deployment reapplies the `THINKING_BUDGET_TOKENS` GitHub variable
(unset means 8192). A request can still set its own `thinking_budget_tokens`.

Output size is bounded by patience and GPU time rather than by the request timeout,
because that timeout is idle-based (see [Request timeouts](#request-timeouts)). At
roughly 60 tokens per second, 8192 thinking tokens is about two minutes before the
answer begins, and a full 32768-token response is about nine. Concurrent requests
share the GPU and are slower still. Lower the thinking budget if turnaround matters
more than depth on hard prompts.

The output limit is a safety rail rather than a target: an answer ends when the model
stops, so a large limit mainly avoids truncating legitimate long output. Its real cost
is that a degenerate repetition loop runs to the cap and occupies a slot while doing so.

Match the client's output limit to the gateway's. A client that sends `max_tokens`
above 32768 gets HTTP 400; in VS Code, set `maxOutputTokens` to 32768 for this model.
A client that sends a lower value silently keeps its own limit, so leaving it at 8192
with an 8192 thinking budget would leave nothing for the answer.

### Request timeouts

Container Apps ingress enforces a **240-second idle timeout, not a total duration
limit**. Measured on this environment with a test app in the same ingress: a request
that sent nothing was severed at **240.8 seconds** with `HTTP 504 stream timeout`,
while a request emitting one byte per second **completed normally after 401 seconds**.
Continuous streaming therefore survives well past 240 seconds; only silence is fatal.

The gateway matches that model with two separate limits:

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPSTREAM_IDLE_TIMEOUT_MS` | 210000 | Rearmed on every chunk. Must stay below the 240-second ingress limit so the gateway returns a clean `504` instead of ingress severing the connection. Capped at 230000. |
| `UPSTREAM_TIMEOUT_MS` | 1800000 | Absolute ceiling for a stream that never ends. Capped at 3600000. |

Silence is what counts against the idle limit on both hops (client to gateway, and
gateway to model over internal ingress). Token generation leaves sub-second gaps and
never approaches it; the case to watch is **time to first token**, when a long prompt
is being processed and the upstream is quiet.

**Streaming is required for long answers.** A non-streamed request sends no bytes
until generation finishes, so the entire generation counts as idle: such a request is
capped at the idle limit, and at 240 seconds by ingress no matter how the gateway is
configured. Measured on this deployment: an identical prompt failed with
`upstream_timeout` at 120 seconds without `stream: true`, and the streamed version
completed in **265 seconds** with `finish_reason: stop` — past the 240-second mark
that bounds every non-streamed request.

## Validation

```powershell
npm test
npm run check
& .\scripts\test-acr-build.ps1
az bicep build --file .\infra\bootstrap.bicep
az bicep build --file .\infra\main.bicep
```

Bicep compilation checks syntax/types, not subscription permissions, GPU capacity,
model/runtime compatibility, file availability, container pulls, or live readiness.
For a local container build (requires Docker):

```powershell
docker build -t inference-gateway:local .
docker run --rm --env-file .env -p 127.0.0.1:8080:8080 inference-gateway:local
```

Inside Docker, a host-local backend typically needs `host.docker.internal`
instead of `127.0.0.1`. Do not use the macOS Metal backend image on Azure; the
GPU model container needs CUDA.
