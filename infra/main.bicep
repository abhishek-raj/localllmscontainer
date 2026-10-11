targetScope = 'resourceGroup'

param environmentName string
@description('Must match the existing environment region.')
param location string
param registryName string
param identityName string = 'qwen-gateway-pull'
param environmentStorageName string = 'qwen-models'
param gatewayName string = 'qwen-gateway'
param modelAppName string = 'qwen-model'

@description('Existing workload profile NAME for Consumption-GPU-NC24-A100, not a dedicated NC24-A100 profile.')
param gpuWorkloadProfileName string

@description('Existing ordinary CPU Consumption profile name.')
param cpuWorkloadProfileName string = 'Consumption'

@description('Gateway image built in the bootstrap registry; prefer an immutable digest.')
param gatewayImage string

@description('Official llama.cpp server-cuda image pinned by digest, e.g. ghcr.io/ggml-org/llama.cpp@sha256:...')
param modelImage string

@description('Supplied from model.json by main.bicepparam.')
param modelFile string
param modelAlias string = 'qwen3.8-27b'

@minValue(1024)
@maxValue(262144)
param contextTokens int

@description('Supplied from model.json by main.bicepparam: MTP draft head stored next to the model.')
param mtpFile string

@description('Use the MTP head for speculative decoding. Flip without a workflow run: az containerapp update --set-env-vars MTP_ENABLED=false (restarts the model container).')
param mtpEnabled bool = true

@description('Maximum thinking tokens per response before llama.cpp forces the answer; -1 means unlimited. Flip without a workflow run: az containerapp update --set-env-vars LLAMA_ARG_THINK_BUDGET=<n> (restarts the model container).')
@minValue(-1)
param thinkingBudgetTokens int = 8192

@description('Largest max_tokens the gateway accepts and its default when a request sets none. Must be below the model context.')
@minValue(1)
@maxValue(32768)
param maxOutputTokens int = 32768

@description('Layers kept in VRAM: "all", "auto", or an exact count. Lower counts spill layers to CPU, which approximates a smaller GPU for capacity testing. Flip without a workflow run: az containerapp update --set-env-vars LLAMA_ARG_N_GPU_LAYERS=40 (restarts the model container).')
param gpuLayers string = 'all'

@description('Optional CIDR allowlist for the public gateway, for example ["203.0.113.4/32"]. Empty means any address may reach the gateway and only the API key stands between the internet and the GPU.')
param allowedClientIpRanges array = []

@description('Optional unique suffix to create fresh revisions of both apps, including after secret rotation.')
@maxLength(50)
param deploymentRevision string = ''

@secure()
@minLength(32)
param gatewayApiKey string

@secure()
@minLength(32)
param backendApiKey string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// llama.cpp loads any configured draft model, so both speculative settings must be set or unset together.
// This wrapper derives them from the single MTP_ENABLED flag when the container starts.
// Windows checkouts give this string CRLF line endings; the command strips CR because /bin/sh rejects it.
var modelEntrypoint = '''
set -eu
case "$(printf '%s' "${MTP_ENABLED:-}" | tr 'A-Z' 'a-z')" in
  true)
    export LLAMA_ARG_SPEC_TYPE=draft-mtp
    export LLAMA_ARG_SPEC_DRAFT_MODEL="$MTP_MODEL_PATH"
    echo "MTP speculative decoding: enabled ($MTP_MODEL_PATH)"
    ;;
  false)
    unset LLAMA_ARG_SPEC_TYPE LLAMA_ARG_SPEC_DRAFT_MODEL
    echo "MTP speculative decoding: disabled"
    ;;
  *)
    echo "MTP_ENABLED must be true or false" >&2
    exit 64
    ;;
esac
exec /app/llama-server
'''

resource model 'Microsoft.App/containerApps@2025-01-01' = {
  name: modelAppName
  location: location
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: gpuWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [{ name: 'backend-api-key', value: backendApiKey }]
      ingress: {
        external: false
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
    }
    template: {
      revisionSuffix: empty(deploymentRevision) ? null : deploymentRevision
      containers: [{
        name: 'model'
        image: modelImage
        command: ['/bin/sh', '-c', replace(modelEntrypoint, '\r', '')]
        resources: { cpu: 24, memory: '220Gi' }
        env: [
          { name: 'LLAMA_ARG_MODEL', value: '/models/${modelFile}' }
          { name: 'MTP_ENABLED', value: mtpEnabled ? 'true' : 'false' }
          { name: 'MTP_MODEL_PATH', value: '/models/${mtpFile}' }
          { name: 'LLAMA_ARG_ALIAS', value: modelAlias }
          { name: 'LLAMA_ARG_HOST', value: '0.0.0.0' }
          { name: 'LLAMA_ARG_PORT', value: '8080' }
          { name: 'LLAMA_ARG_N_GPU_LAYERS', value: gpuLayers }
          { name: 'LLAMA_ARG_CTX_SIZE', value: string(contextTokens) }
          { name: 'LLAMA_ARG_N_PARALLEL', value: '3' }
          { name: 'LLAMA_ARG_KV_UNIFIED', value: 'true' }
          { name: 'LLAMA_ARG_THINK_BUDGET', value: string(thinkingBudgetTokens) }
          { name: 'LLAMA_ARG_THINK_BUDGET_MESSAGE', value: '\n\nI have reached my thinking budget. I will summarize what I established, then take one concrete step, choosing a different one if my last action failed.\n' }
          { name: 'LLAMA_ARG_JINJA', value: 'true' }
          { name: 'LLAMA_API_KEY', secretRef: 'backend-api-key' }
        ]
        volumeMounts: [{ volumeName: 'models', mountPath: '/models' }]
        probes: [
          {
            type: 'Startup'
            httpGet: { path: '/health', port: 8080 }
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 60
          }
          {
            type: 'Readiness'
            httpGet: { path: '/health', port: 8080 }
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          }
        ]
      }]
      volumes: [{
        name: 'models'
        storageType: 'AzureFile'
        storageName: environmentStorageName
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        cooldownPeriod: 600
        rules: [{
          name: 'inference-http'
          http: { metadata: { concurrentRequests: '3' } }
        }]
      }
    }
  }
}

resource gateway 'Microsoft.App/containerApps@2025-01-01' = {
  name: gatewayName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: cpuWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{
        server: registry.properties.loginServer
        identity: pullIdentity.id
      }]
      secrets: [
        { name: 'gateway-api-key', value: gatewayApiKey }
        { name: 'backend-api-key', value: backendApiKey }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        // Any Allow rule makes every other address denied at the edge, before the GPU can wake.
        ipSecurityRestrictions: [for (range, index) in allowedClientIpRanges: {
          name: 'allowed-${index}'
          description: 'Operator allowlist'
          ipAddressRange: range
          action: 'Allow'
        }]
      }
    }
    template: {
      revisionSuffix: empty(deploymentRevision) ? null : deploymentRevision
      containers: [{
        name: 'gateway'
        image: gatewayImage
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'PORT', value: '8080' }
          { name: 'BACKEND_URL', value: 'https://${model.properties.configuration.ingress.fqdn}' }
          { name: 'MODEL_ALIAS', value: modelAlias }
          { name: 'GATEWAY_API_KEY', secretRef: 'gateway-api-key' }
          { name: 'BACKEND_API_KEY', secretRef: 'backend-api-key' }
          { name: 'MAX_BODY_BYTES', value: '1048576' }
          { name: 'MAX_CONCURRENT_REQUESTS', value: '3' }
          { name: 'REQUESTS_PER_MINUTE', value: '30' }
          { name: 'MAX_OUTPUT_TOKENS', value: string(maxOutputTokens) }
          { name: 'UPSTREAM_TIMEOUT_MS', value: '1800000' }
          { name: 'UPSTREAM_IDLE_TIMEOUT_MS', value: '210000' }
        ]
        probes: [
          {
            type: 'Startup'
            httpGet: { path: '/healthz', port: 8080 }
            periodSeconds: 2
            failureThreshold: 30
          }
          {
            type: 'Readiness'
            httpGet: { path: '/readyz', port: 8080 }
            periodSeconds: 10
          }
          {
            type: 'Liveness'
            httpGet: { path: '/healthz', port: 8080 }
            periodSeconds: 30
          }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{
          name: 'gateway-http'
          http: { metadata: { concurrentRequests: '10' } }
        }]
      }
    }
  }
}

output gatewayBaseUrl string = 'https://${gateway.properties.configuration.ingress.fqdn}/v1'
output modelInternalUrl string = 'https://${model.properties.configuration.ingress.fqdn}'
