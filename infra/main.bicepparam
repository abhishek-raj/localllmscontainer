using './main.bicep'

param environmentName = readEnvironmentVariable('ACA_ENVIRONMENT')
param location = readEnvironmentVariable('AZURE_LOCATION')
param registryName = readEnvironmentVariable('ACR_NAME')
param gpuWorkloadProfileName = readEnvironmentVariable('GPU_PROFILE_NAME')
param gatewayImage = readEnvironmentVariable('GATEWAY_IMAGE')
param modelImage = readEnvironmentVariable('MODEL_IMAGE')
param gatewayApiKey = readEnvironmentVariable('GATEWAY_API_KEY')
param backendApiKey = readEnvironmentVariable('BACKEND_API_KEY')
param deploymentRevision = readEnvironmentVariable('DEPLOYMENT_REVISION', '')
param modelFile = loadJsonContent('../model.json', 'fileName')
param contextTokens = loadJsonContent('../model.json', 'contextTokens')
param mtpFile = loadJsonContent('../model.json', 'mtp.fileName')
// Unset or empty means enabled; the workflow rejects values other than true/false.
param mtpEnabled = toLower(readEnvironmentVariable('MTP_ENABLED', 'true')) != 'false'
// Unset or empty means 4096; the workflow rejects values that aren't integers >= -1.
param thinkingBudgetTokens = empty(readEnvironmentVariable('THINKING_BUDGET_TOKENS', '')) ? 4096 : int(readEnvironmentVariable('THINKING_BUDGET_TOKENS', '4096'))
