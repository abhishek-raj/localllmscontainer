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
- Only `POST /v1/chat/completions` and `POST /v1/completions` are forwarded.
- `GET /v1/models` requires authentication and returns the configured model locally.
- Public `/healthz` and `/readyz` only check that the gateway is running. They do
  **not** assert that the model is loaded, reachable, or correctly configured.
- Streaming SSE and JSON responses, backpressure, cancellation on disconnect,
  bounded upload and upstream timeouts, no automatic retries, no redirect following.
- Separate backend credentials; client headers, cookies, and backend error bodies
  are not forwarded indiscriminately. No request bodies or keys in application logs.
- Default limits: 1 MiB body, one active inference/upload, 30 authenticated inference
  attempts per minute, 4096 output tokens. `max_completion_tokens` is normalized
  to `max_tokens`; unbounded values, `n_predict`, and `n > 1` are rejected.
- Non-root Docker image and Bicep for a public CPU app and internal A100 app.

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

## Azure deployment

**Nothing is deployed just by building or testing this project.** The commands
below create billable resources. Review the pricing and template before running.
No Azure deployment or GPU inference has yet been validated by this project.

### Prerequisites

- Existing workload-profiles Container Apps environment and A100 quota.
- Both ordinary CPU `Consumption` and **Consumption-GPU-NC24-A100** profiles.
  The template needs the actual *profile name*, not its type. Never use a dedicated
  NC24-A100 profile if scale-to-zero billing is required.
- Azure CLI with Bicep and permissions to deploy resources, assign the AcrPull role,
  build images, and access the file share. Register the Microsoft.App,
  Microsoft.ContainerRegistry, Microsoft.Storage and Microsoft.ManagedIdentity
  providers if they are not already registered.
- An environment dedicated to trusted apps: other apps inside the environment can
  reach the internal model ingress. No public environment HTTP route may target
  the model app. Network isolation of internal ingress is essential; a backend key
  by itself does not prevent direct requests from waking the GPU.

Use a resource group containing the **existing** environment:

```powershell
az login
az account set --subscription '<subscription-id>'
$rg = '<resource-group>'
$env:ACA_ENVIRONMENT = '<existing-environment-name>'
$env:ACR_NAME = '<globally-unique-registry-name>'
$storage = '<globallyuniquelowercasestorage>'
$env:GPU_PROFILE_NAME = '<existing-A100-consumption-profile-name>'
$env:AZURE_LOCATION = az containerapp env show --name $env:ACA_ENVIRONMENT --resource-group $rg --query location -o tsv
az containerapp env show --name $env:ACA_ENVIRONMENT --resource-group $rg --query properties.workloadProfiles -o table
```

### 1. Bootstrap registry and model storage

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

Download `Qwen3.8-27B-UD-Q6_K.gguf` from
[the Unsloth repository](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF).
This is the **dynamic** Q6_K variant. Review the model license and source; compare
its SHA-256 with the file's published LFS SHA-256 and record the repository revision.
Upload this one file to the root of the `models` share with Azure Storage Explorer.
If using another GGUF, update `modelFile` in the parameters and verify runtime support.

**Complete the upload before deploying the GPU app.** The app loads from
`/models` and never downloads weights at startup. Azure Files throughput can
dominate cold-start time. The read-only mount avoids modifying the model from
inside the container, but does not protect against a storage administrator
replacing it.

### 2. Build the gateway image

Azure ACR Tasks can build it without local Docker:

```powershell
az acr build --registry $env:ACR_NAME --image inference-gateway:v1 --file Dockerfile .
$loginServer = az acr show --name $env:ACR_NAME --query loginServer -o tsv
$digest = az acr repository show --name $env:ACR_NAME --image inference-gateway:v1 --query digest -o tsv
$env:GATEWAY_IMAGE = "$loginServer/inference-gateway@$digest"
```

Stop on any CLI failure; do not continue with empty output variables.
Registry role assignments may take a few minutes to propagate before the
gateway can pull its image.

Choose a tested official
[llama.cpp CUDA 12 server image](https://github.com/ggml-org/llama.cpp/blob/master/docs/docker.md)
compatible with this model, and pin its digest:

```powershell
$env:MODEL_IMAGE = 'ghcr.io/ggml-org/llama.cpp@sha256:<digest-for-server-cuda>'
```

If Docker is available, `docker buildx imagetools inspect ghcr.io/ggml-org/llama.cpp:server-cuda`
shows the current digest. Do not copy the placeholder above unchanged.
Pinning is not a substitute for applying tested security updates.

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
7. Send one authorized chat request and observe the model wake and CUDA load.
8. Verify a streamed response, then confirm the model eventually scales down.

Example request after obtaining the gateway domain from deployment outputs:

```powershell
$base = 'https://<gateway-domain>'
$headers = @{ Authorization = "Bearer $env:GATEWAY_API_KEY" }
Invoke-RestMethod "$base/v1/models" -Headers $headers
$body = @{
  model = 'qwen3.8-27b'
  messages = @(@{ role = 'user'; content = 'Write a TypeScript sum function.' })
  max_tokens = 256
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

Your coding client uses base URL `https://<gateway-domain>/v1`, the **gateway**
key, and model `qwen3.8-27b`. Never configure a client with the backend key.

## GitHub Actions deployment

[.github/workflows/azure.yml](.github/workflows/azure.yml) runs tests and compiles
Bicep on pushes and pull requests. **Only a manual workflow run from the default
branch deploys**, after validation succeeds and any `production` environment
approvals are granted. Pull requests receive no Azure identity or inference keys.

The workflow builds the **gateway** with ACR Tasks, resolves its digest, and uses
the main Bicep template to deploy **both apps**. The model app uses your pinned
official llama.cpp CUDA image. Its GGUF weights stay in Azure Files; Actions does
not rebuild the model runtime or upload/download the model on each deployment.
ACR Tasks performs the Linux image build remotely from the Windows runner, so
Docker does not need to be installed on the runner.

### One-time prerequisites

1. Put this project in a GitHub repository. The workflow must be on the repository's
   default branch before **Run workflow** is available.
2. Complete the bootstrap and model upload in Azure deployment steps 1-2 above
   (the manual gateway build itself is optional; Actions will build it). Use the
   bootstrap defaults for `qwen-gateway-pull`, `qwen-models`, and `models`.
3. Verify A100 quota, the CPU Consumption profile, and the named serverless A100
   profile. Verify the image digest really refers to `server-cuda`, not a CPU or
   macOS image; the workflow can validate digest syntax, not runtime compatibility.
4. Create a GitHub environment named **`production`** under repository
   **Settings -> Environments**. Restrict deployment branches to your default
   branch and enable required reviewers where your GitHub plan supports them.
5. Set up Azure OIDC as described below. Do not create a long-lived Azure client secret.

Bootstrap remains a one-time administrator task because it creates role
assignments and storage. The deployment identity does not need permission to
assign roles. The main template manages apps called `qwen-gateway` and
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

For this starter, grant the deployment identity **Contributor scoped to the
dedicated resource group** containing the apps, environment, registry, and pull
identity. With the bootstrap registry's standard RBAC mode, this covers the
deployment, ACR Tasks build, and registry metadata reads used here. Do not grant
subscription Owner. A custom least-privilege role can narrow this further; it must
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
| `GPU_PROFILE_NAME` | Existing profile name whose type is `Consumption-GPU-NC24-A100` |
| `MODEL_IMAGE` | `ghcr.io/ggml-org/llama.cpp@sha256:<64-character-digest>` for the CUDA server |

Add these **environment secrets**:

| Secret | Value |
| --- | --- |
| `GATEWAY_API_KEY` | Your random client key, at least 32 characters |
| `BACKEND_API_KEY` | A different random backend key, at least 32 characters |

The environment's region is discovered automatically. Keys are exposed only to
steps that need them, not to the ACR build step. No real-key parameter JSON or
deployment artifact is published. Never enable shell tracing or CLI debug output
on secret-handling steps. The workflow uses secure Bicep parameters, but Azure and
GitHub administrators with sufficient permissions remain trusted.

### Deploy and verify

Open **Actions -> Validate and deploy inference apps -> Run workflow**, select
the default branch, and approve the production deployment if requested.

The deployment job is serialized and does not cancel an active deployment.
It creates uniquely named revisions of **both** apps on every run, even when the
model image stays the same, so changed API keys are loaded consistently. This
can restart the model, cause a brief interruption, and incur GPU initialization
charges. Cancellation or failure is not an automatic rollback.

After deployment, it verifies internal model/public gateway ingress, HTTPS-only
access, replica limits, and readiness of the exact new revisions. It then runs
[scripts/smoke.mjs](scripts/smoke.mjs):

- Gateway-local health and readiness.
- Authenticated model discovery.
- Missing/invalid credentials rejected with `401` on a deliberately unsupported
  path, so even an authentication regression cannot make this check send inference.

The Actions summary contains the gateway base URL and both image digests, not
keys. No inference request is sent by these smoke checks; **deployment itself
can still wake the GPU**. Actual model inference, direct-ingress isolation,
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
  Add gateway IP restrictions for personal use.
- In-memory limits are per gateway process and reset on restart. They are not
  durable quotas or a hard spending cap. With additional replicas or overlapping
  revisions, aggregate limits increase. A stolen valid key can keep one A100 busy.
- Backend readiness probes are local to the GPU replica; the gateway never probes
  it. Scaling cooldown is platform-controlled and GPU charges continue while a
  replica remains running, including idle and initialization time.
- The upstream timeout is 210 seconds total, including stream duration, to stay
  below the common Container Apps HTTP request ceiling of 240 seconds. A long
  model load can outlast it. A `504` does not prove the GPU stopped. This gateway
  never retries automatically; after observing readiness, retry manually. If
  multi-minute cold starts or long agent streams are frequent, reconsider this
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
- Check gateway structured logs for `request_failed`, `upstream_rejected`, and
  `inference_complete`; use request IDs, not sensitive prompts, for correlation.
  Inspect llama.cpp and platform logging separately for prompt/privacy exposure.

## Validation

```powershell
npm test
npm run check
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
