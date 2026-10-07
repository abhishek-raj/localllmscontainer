$ErrorActionPreference = 'Stop'
$state = [pscustomobject]@{
    Calls = @()
    Scenario = 'success'
    Digest = 'sha256:' + ('a' * 64)
}

# Exercise the real build script without an Azure account or registry login.
function az {
    $state.Calls += ($args -join ' ')
    $global:LASTEXITCODE = 0
    if (($args[0..2] -join ' ') -eq 'acr show --name') {
        if ($state.Scenario -eq 'registry-error') { $global:LASTEXITCODE = 1; return }
        return 'test.azurecr.io'
    }
    if (($args[0..1] -join ' ') -ne 'acr build') {
        throw 'Unexpected CLI command: registry data-plane authentication must not be used'
    }
    if ($args -notcontains '--no-logs' -or $args -contains '--no-wait') {
        throw 'Build must wait and return structured run metadata'
    }
    if ($state.Scenario -eq 'build-error') { $global:LASTEXITCODE = 1; return }
    if ($state.Scenario -eq 'invalid-json') { return '{invalid' }
    $status = 'Succeeded'
    if ($state.Scenario -eq 'failed-run') { $status = 'Failed' }
    $image = @{
        registry = 'test.azurecr.io'
        repository = 'inference-gateway'
        tag = 'test-tag'
        digest = $state.Digest
    }
    if ($state.Scenario -eq 'wrong-tag') { $image.tag = 'other-tag' }
    if ($state.Scenario -eq 'wrong-registry') { $image.registry = 'other.azurecr.io' }
    if ($state.Scenario -eq 'invalid-digest') { $image.digest = 'sha256:bad' }
    $images = @($image)
    if ($state.Scenario -eq 'missing-image') { $images = @() }
    if ($state.Scenario -eq 'duplicate-image') { $images = @($image, $image) }
    @{
        runId = 'ds1'
        status = $status
        outputImages = $images
    } | ConvertTo-Json -Depth 5
}

$buildScript = Join-Path $PSScriptRoot 'build-gateway.ps1'
$actual = & $buildScript -Registry test -ResourceGroup test-rg -Tag test-tag
if ($actual -ne "test.azurecr.io/inference-gateway@$($state.Digest)") {
    throw 'Build did not return the exact immutable image reference'
}
if ($state.Calls.Count -ne 2) { throw 'Expected registry lookup and build only' }

foreach ($scenario in @('registry-error', 'build-error', 'failed-run', 'wrong-tag', 'wrong-registry',
    'invalid-digest', 'missing-image', 'duplicate-image', 'invalid-json')) {
    $state.Scenario = $scenario
    $rejected = $false
    try {
        & $buildScript -Registry test -ResourceGroup test-rg -Tag test-tag | Out-Null
    } catch {
        $rejected = $true
    }
    if (-not $rejected) { throw "Build accepted invalid scenario: $scenario" }
}
Write-Output 'ACR build regression checks passed: successful digest plus nine fail-closed cases; no data-plane calls.'
