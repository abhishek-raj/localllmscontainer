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
