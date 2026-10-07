targetScope = 'resourceGroup'

@description('Existing workload-profiles Container Apps environment in this resource group.')
param environmentName string

@description('Must match the existing environment region.')
param location string

@description('Globally unique registry name, letters and digits only.')
param registryName string

@description('Globally unique storage account name, lowercase letters and digits only.')
param storageAccountName string

param identityName string = 'qwen-gateway-pull'
param environmentStorageName string = 'qwen-models'
param shareName string = 'models'

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: 64
  }
}

resource modelMount 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: environmentStorageName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadOnly'
    }
  }
}

output registryLoginServer string = registry.properties.loginServer
output gatewayIdentityName string = pullIdentity.name
output modelStorageName string = modelMount.name
output modelShareName string = share.name
