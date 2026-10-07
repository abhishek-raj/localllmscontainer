$ErrorActionPreference = 'Stop'
$state = [pscustomobject]@{ Scenario = 'healthy'; Calls = 0 }
$expected = 'qwen-model--test'
function Start-Sleep {}
function az {
    $state.Calls++
    $global:LASTEXITCODE = 0
    if (($args[0..2] -join ' ') -ne 'containerapp revision show' -or $args -notcontains $expected) {
        throw 'Readiness check must inspect the exact deployed revision'
    }
    if ($state.Scenario -eq 'cli-error') { $global:LASTEXITCODE = 1; return }
    if ($state.Scenario -eq 'invalid-json') { return '{invalid' }
    $revision = @{
        name = $expected
        properties = @{ active = $true; healthState = 'Healthy'; replicas = 1; runningState = 'Running'; provisioningState = 'Provisioned' }
    }
    switch ($state.Scenario) {
        'wrong-revision' { $revision.name = 'qwen-model--old' }
        'inactive' { $revision.properties.active = $false }
        'zero-replicas' { $revision.properties.replicas = 0 }
        'activation-failed' { $revision.properties.runningState = 'ActivationFailed' }
        'provisioning-failed' { $revision.properties.provisioningState = 'Failed' }
        'not-healthy' { $revision.properties.healthState = 'None' }
        'missing-health' { $revision.properties.Remove('healthState') }
        'eventually-healthy' { if ($state.Calls -eq 1) { $revision.properties.healthState = 'None' } }
    }
    $revision | ConvertTo-Json -Depth 5
}
$scriptPath = Join-Path $PSScriptRoot 'verify-model-ready.ps1'
& $scriptPath -ResourceGroup test-rg -Revision $expected -TimeoutSeconds 1
if ($state.Calls -ne 1) { throw 'Healthy revision should pass immediately' }
$state.Scenario = 'eventually-healthy'
$state.Calls = 0
& $scriptPath -ResourceGroup test-rg -Revision $expected -TimeoutSeconds 10
if ($state.Calls -ne 2) { throw 'Readiness must wait for health rather than provisioning alone' }
foreach ($scenario in @('cli-error', 'invalid-json', 'wrong-revision', 'inactive', 'zero-replicas',
    'activation-failed', 'provisioning-failed', 'not-healthy', 'missing-health')) {
    $state.Scenario = $scenario
    $state.Calls = 0
    $rejected = $false
    try { & $scriptPath -ResourceGroup test-rg -Revision $expected -TimeoutSeconds 1 } catch { $rejected = $true }
    if (-not $rejected) { throw "Accepted invalid readiness scenario: $scenario" }
    if ($state.Calls -ne 1) { throw 'Deadline must bound the readiness checks' }
}
Write-Output 'Model readiness checks passed: immediate/delayed health and nine fail-closed cases.'
