param(
    [Parameter(Mandatory = $true)][string] $Registry,
    [Parameter(Mandatory = $true)][string] $ResourceGroup,
    [Parameter(Mandatory = $true)][string] $Tag
)

$ErrorActionPreference = 'Stop'
$imageTag = "inference-gateway:$Tag"
$server = az acr show --name $Registry --resource-group $ResourceGroup --query loginServer -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($server)) {
    throw 'Cannot resolve registry server'
}

# --no-logs waits for completion and returns the run object, including outputImages.
$raw = az acr build --registry $Registry --resource-group $ResourceGroup --image $imageTag --file Dockerfile --platform linux/amd64 . --no-logs --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Gateway container build failed' }
$run = $raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($run.runId) -or $run.status -ne 'Succeeded') {
    throw "ACR build did not succeed (run: $($run.runId), status: $($run.status))"
}

$images = @($run.outputImages | Where-Object {
    $_.registry -eq $server -and $_.repository -eq 'inference-gateway' -and $_.tag -eq $Tag
})
if ($images.Count -ne 1 -or $images[0].digest -cnotmatch '^sha256:[a-f0-9]{64}$') {
    throw "ACR run $($run.runId) did not return exactly one valid digest for $imageTag"
}
Write-Host "ACR run $($run.runId) succeeded. Build logs: az acr task logs --registry $Registry --run-id $($run.runId)"
"$server/inference-gateway@$($images[0].digest)"
