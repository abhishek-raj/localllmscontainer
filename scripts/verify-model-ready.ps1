param(
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $Revision,
    [ValidateRange(1, 540)][int] $TimeoutSeconds = 540
)
$ErrorActionPreference = 'Stop'
$timer = [Diagnostics.Stopwatch]::StartNew()
$attempts = [Math]::Ceiling($TimeoutSeconds / 5)
Write-Host "Waiting for actual model health on $Revision (not just latestReadyRevisionName)."
for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
    $raw = az containerapp revision show --name qwen-model --resource-group $ResourceGroup --revision $Revision --output json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read model revision health' }
    $revisionStatus = $raw | ConvertFrom-Json
    if ($revisionStatus.name -ne $Revision) { throw 'Azure returned an unexpected model revision' }
    $properties = $revisionStatus.properties
    if ($properties.provisioningState -eq 'Failed' -or $properties.runningState -eq 'ActivationFailed') {
        throw 'Model activation failed; inspect model system and console logs'
    }
    if ($properties.active -eq $true -and $properties.healthState -eq 'Healthy' -and $properties.replicas -ge 1) {
        Write-Host "Model revision $Revision is healthy with a running replica."
        return
    }
    $remaining = $TimeoutSeconds - $timer.Elapsed.TotalSeconds
    if ($remaining -le 0 -or $attempt + 1 -ge $attempts) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min(5000, $remaining * 1000))
}
throw 'Model revision did not become healthy before the deadline; inspect model logs'
