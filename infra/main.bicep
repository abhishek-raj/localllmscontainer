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

param modelFile string = 'Qwen3.8-27B-UD-Q6_K.gguf'
param modelAlias string = 'qwen3.8-27b'

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
        resources: { cpu: 24, memory: '220Gi' }
        env: [
          { name: 'LLAMA_ARG_MODEL', value: '/models/${modelFile}' }
          { name: 'LLAMA_ARG_ALIAS', value: modelAlias }
          { name: 'LLAMA_ARG_HOST', value: '0.0.0.0' }
          { name: 'LLAMA_ARG_PORT', value: '8080' }
          { name: 'LLAMA_ARG_N_GPU_LAYERS', value: 'all' }
          { name: 'LLAMA_ARG_CTX_SIZE', value: '16384' }
          { name: 'LLAMA_ARG_N_PARALLEL', value: '1' }
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
        cooldownPeriod: 120
        rules: [{
          name: 'inference-http'
          http: { metadata: { concurrentRequests: '1' } }
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
          { name: 'MAX_CONCURRENT_REQUESTS', value: '1' }
          { name: 'REQUESTS_PER_MINUTE', value: '30' }
          { name: 'MAX_OUTPUT_TOKENS', value: '4096' }
          { name: 'UPSTREAM_TIMEOUT_MS', value: '210000' }
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
