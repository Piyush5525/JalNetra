<#
JalNetra Conduct Demo release helper  (run in PowerShell from the repo root: C:\Users\swast\omnirush.ai\jalnetra)

Phases (run one at a time, in this order):
  prep     check AWS identity, build aws-api, REMOVE ALERT_PHONE from the telephony secret (backs it up locally first)
  deploy   cdk diff, then cdk deploy after you type DEPLOY
  migrate  invoke jalnetra-schema-migration, check the result and the API timeout
  smoke    no-provider smoke test against the live API (aborts BEFORE any approve if the API reports a configured phone)
  restore  put ALERT_PHONE back into the secret  (only when you are ready for the real-call test)

This script never places a call. Usage:   .\jalnetra-demo-release.ps1 -Phase prep
Needs: aws CLI logged in to the account that owns jalnetra-api, node/npm, curl.exe (ships with Windows 10+).
Secrets are never printed. The operator key is read with a hidden prompt and kept only in memory.
#>
param([Parameter(Mandatory = $true)][ValidateSet('prep', 'deploy', 'migrate', 'smoke', 'restore', 'call')][string]$Phase)

$ErrorActionPreference = 'Stop'
$Region = 'ap-south-1'
$SecretId = 'jalnetra/prototype/telephony'
$ApiUrl = 'https://u51iah4nqf.execute-api.ap-south-1.amazonaws.com'
$Repo = (Get-Location).Path
$Backup = Join-Path $env:USERPROFILE 'jalnetra-alert-phone.backup.json'
$PhoneKeys = @('ALERT_PHONE', 'alertPhone')

function Invoke-Aws { & aws.exe @args --region $Region; if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed" } }
function Get-AwsOut { $o = & aws.exe @args --region $Region; if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed" }; $o }
function Confirm-Step($text) { $a = Read-Host "$text  (type YES to continue)"; if ($a -ne 'YES') { throw 'Stopped by user.' } }
function Get-SecretObject { (Get-AwsOut secretsmanager get-secret-value --secret-id $SecretId --query SecretString --output text) | ConvertFrom-Json }
function Put-SecretObject($obj) {
  $tmp = New-TemporaryFile
  try {
    ($obj | ConvertTo-Json -Depth 10 -Compress) | Set-Content -Path $tmp -Encoding ascii
    Invoke-Aws secretsmanager put-secret-value --secret-id $SecretId --secret-string "file://$($tmp.FullName)" | Out-Null
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

function Invoke-Api($method, $path, $body, $key) {
  $h = New-TemporaryFile; $o = New-TemporaryFile; $b = New-TemporaryFile; $c = New-TemporaryFile
  try {
    # curl config files treat backslashes inside quotes as escapes (\t in ...\Temp\tmpXXXX.tmp becomes a tab), so use forward slashes
    $hp = $h.FullName -replace '\\', '/'; $op = $o.FullName -replace '\\', '/'; $bp = $b.FullName -replace '\\', '/'
    $cfg = @('silent', 'max-time = 25', "request = `"$method`"", "url = `"$ApiUrl$path`"", "dump-header = `"$hp`"", "output = `"$op`"")
    if ($key) { $cfg += "header = `"x-jalnetra-key: $key`"" }
    if ($null -ne $body) { ($body | ConvertTo-Json -Compress) | Set-Content $b.FullName -Encoding ascii; $cfg += 'header = "content-type: application/json"'; $cfg += "data-binary = `"@$bp`"" }
    $cfg | Set-Content $c.FullName -Encoding ascii
    $code = [int](& curl.exe -K $c.FullName -w '%{http_code}')
    $raw = Get-Content $o.FullName -Raw; $json = $null; try { $json = $raw | ConvertFrom-Json } catch {}
    [pscustomobject]@{ Status = $code; Raw = $raw; Json = $json }
  } finally { Remove-Item $h, $o, $b, $c -Force -ErrorAction SilentlyContinue }
}

function Assert-Repo { if (-not (Test-Path (Join-Path $Repo 'aws-api\schema.sql')) -or -not (Test-Path (Join-Path $Repo 'infra\cdk.json'))) { throw "Run this from the jalnetra repo root (not found: aws-api\schema.sql / infra\cdk.json). Current: $Repo" } }

switch ($Phase) {

  'prep' {
    Assert-Repo
    Write-Host 'AWS identity:'; Invoke-Aws sts get-caller-identity --query '[Account,Arn]' --output text
    Confirm-Step 'Is this the account that owns jalnetra-api?'

    $envKeys = (Get-AwsOut lambda get-function-configuration --function-name jalnetra-api --query 'Environment.Variables' --output json) | ConvertFrom-Json
    $names = if ($envKeys) { $envKeys.PSObject.Properties.Name } else { @() }
    if ($names | Where-Object { $_ -in @('ALERT_PHONE', 'JN_ALERT_PHONE') }) { throw 'ALERT_PHONE / JN_ALERT_PHONE is a plain Lambda environment variable. Stop: that needs a separate decision.' }
    Write-Host "Lambda env var names (values not shown): $($names -join ', ')"

    Write-Host 'Building aws-api ...'
    Push-Location (Join-Path $Repo 'aws-api')
    try {
      if (Test-Path '.test-build') { Remove-Item '.test-build' -Recurse -Force }
      npm run build; if ($LASTEXITCODE -ne 0) { throw 'aws-api build failed' }
    } finally { Pop-Location }

    $s = Get-SecretObject
    Write-Host "Secret keys: $($s.PSObject.Properties.Name -join ', ')"
    $present = $PhoneKeys | Where-Object { $s.PSObject.Properties.Name -contains $_ }
    if (-not $present) { Write-Host 'No ALERT_PHONE in the secret already. Nothing to remove.'; break }
    $bak = @{}; foreach ($k in $present) { $bak[$k] = $s.$k }
    $bak | ConvertTo-Json | Set-Content -Path $Backup -Encoding ascii
    Write-Host "Backed up the phone value to $Backup (outside the repo). Keep this file private."
    Confirm-Step 'Remove ALERT_PHONE from the secret now? (the demo phone stays removed until you run -Phase restore)'
    foreach ($k in $present) { $s.PSObject.Properties.Remove($k) }
    Put-SecretObject $s
    Write-Host 'ALERT_PHONE removed from the secret. Now run -Phase deploy (a fresh deploy gives Lambda fresh containers).'
  }

  'deploy' {
    Assert-Repo
    $s = Get-SecretObject
    if ($PhoneKeys | Where-Object { $s.PSObject.Properties.Name -contains $_ }) { Write-Host 'NOTE: ALERT_PHONE is in the secret. Do not run -Phase smoke until it is removed (-Phase prep) and containers are fresh.' -ForegroundColor Yellow }
    Push-Location (Join-Path $Repo 'infra')
    try {
      Write-Host '--- cdk diff ---'
      npx cdk diff
      Write-Host @'

Expected: only code-asset changes on jalnetra-api, jalnetra-schema-migration, jalnetra-data-import.
STOP if the diff shows the database, VPC, schedules, replacements or deletions.
'@
      $a = Read-Host 'Type DEPLOY to deploy, anything else to stop'
      if ($a -ne 'DEPLOY') { throw 'Stopped by user.' }
      npx cdk deploy
      if ($LASTEXITCODE -ne 0) { throw 'cdk deploy failed' }
    } finally { Pop-Location }
    Write-Host 'Deployed. Next: -Phase migrate'
  }

  'migrate' {
    $out = Join-Path $env:TEMP 'jalnetra-migrate-out.json'
    $resp = (Get-AwsOut lambda invoke --function-name jalnetra-schema-migration --cli-binary-format raw-in-base64-out $out --output json) | ConvertFrom-Json
    $body = Get-Content $out -Raw
    Write-Host "StatusCode=$($resp.StatusCode) FunctionError=$($resp.FunctionError)"; Write-Host $body
    if ($resp.FunctionError -or ($body | ConvertFrom-Json).success -ne $true) { throw 'Migration did not report success. Check CloudWatch log group /aws/lambda/jalnetra-schema-migration. Do not retry blindly.' }
    $t = [int](Get-AwsOut lambda get-function-configuration --function-name jalnetra-api --query Timeout --output text)
    Write-Host "jalnetra-api timeout: $t s"
    if ($t -lt 15) { throw 'jalnetra-api timeout is below 15 s. Fix before testing OmniDimension.' }
    Write-Host 'Migration OK. Check CloudWatch for /aws/lambda/jalnetra-schema-migration, then run -Phase smoke.'
  }

  'smoke' {
    $s = Get-SecretObject
    if ($PhoneKeys | Where-Object { $s.PSObject.Properties.Name -contains $_ }) { throw 'ALERT_PHONE is still in the secret: approving would place a real call. Run -Phase prep and -Phase deploy first.' }
    $sec = Read-Host 'Operator key (hidden)' -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $sec2 = Read-Host 'SECOND operator key for the cross-operator check (hidden, Enter to skip)' -AsSecureString
    $key2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2))

    $script:fails = 0
    function Call($method, $path, $body, $k) {
      $h = New-TemporaryFile; $o = New-TemporaryFile; $b = New-TemporaryFile
      try {
        $args2 = @('-s', '-D', $h.FullName, '-o', $o.FullName, '-w', '%{http_code}', '-X', $method, "$ApiUrl$path")
        if ($k) { $args2 += @('-H', "x-jalnetra-key: $k") }
        if ($null -ne $body) { ($body | ConvertTo-Json -Compress) | Set-Content $b.FullName -Encoding ascii; $args2 += @('-H', 'content-type: application/json', '--data-binary', "@$($b.FullName)") }
        $code = [int](& curl.exe @args2)
        $raw = Get-Content $o.FullName -Raw
        $json = $null; try { $json = $raw | ConvertFrom-Json } catch {}
        [pscustomobject]@{ Status = $code; Raw = $raw; Json = $json; Headers = (Get-Content $h.FullName -Raw) }
      } finally { Remove-Item $h, $o, $b -Force -ErrorAction SilentlyContinue }
    }
    function Check($name, $cond, $detail) { if ($cond) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name  $detail" -ForegroundColor Red; $script:fails++ } }
    $ids = @()
    function NewId { $g = [guid]::NewGuid().ToString(); $script:ids += $g; $g }

    $r = Call 'POST' '/demo/sessions' @{ requestId = (NewId) } $null
    Check 'a1 no key -> 401 UNAUTHENTICATED' ($r.Status -eq 401 -and $r.Json.code -eq 'UNAUTHENTICATED') "got $($r.Status)"
    $r = Call 'POST' '/demo/sessions' @{ requestId = (NewId) } 'definitely-not-a-key'
    Check 'a2 wrong key -> 401' ($r.Status -eq 401) "got $($r.Status)"

    $rid = NewId
    $r = Call 'POST' '/demo/sessions' @{ requestId = $rid } $key
    Check 'b create session -> 201' ($r.Status -eq 201) "got $($r.Status): $($r.Raw)"
    if ($r.Status -ne 201) { throw "Cannot continue. If this is 500, the migration has not created the tables." }
    $sess = $r.Json
    Check 'b 5 alerts, all pending / not_requested' (($sess.alerts.Count -eq 5) -and -not ($sess.alerts | Where-Object { $_.approvalStatus -ne 'pending' -or $_.callStatus -ne 'not_requested' })) 'alert states'
    Check 'b demo destination NOT configured' ($sess.demoDestination.configured -eq $false) 'API reports a configured phone'
    if ($sess.demoDestination.configured -ne $false) { throw 'ABORT: API reports a configured demo phone. Not approving anything.' }

    $r2 = Call 'POST' '/demo/sessions' @{ requestId = $rid } $key
    Check 'c same requestId -> 200 same session' ($r2.Status -eq 200 -and $r2.Json.id -eq $sess.id) "got $($r2.Status)"

    $a1 = $sess.alerts[0].id
    $path = "/demo/sessions/$($sess.id)/alerts/$a1/approve"
    $r = Call 'POST' $path @{ requestId = (NewId); forecastHorizonHours = 6 } $key
    Check 'd approve -> 200, not_configured, 0 attempts' ($r.Status -eq 200 -and $r.Json.replayed -eq $false -and $r.Json.alert.callStatus -eq 'not_configured' -and $r.Json.alert.callAttempts -eq 0 -and $r.Json.session.allowance.callsUsed -eq 0) "got $($r.Status): $($r.Raw)"
    $r = Call 'POST' $path @{ requestId = (NewId); forecastHorizonHours = 6 } $key
    Check 'e repeat -> 200 replayed=true' ($r.Status -eq 200 -and $r.Json.replayed -eq $true -and $r.Json.alert.callStatus -eq 'not_configured') "got $($r.Status)"
    $r = Call 'POST' $path @{ requestId = (NewId); forecastHorizonHours = 12 } $key
    Check 'f different horizon -> 409 ALREADY_APPROVED' ($r.Status -eq 409 -and $r.Json.code -eq 'ALREADY_APPROVED') "got $($r.Status)"
    $a2path = "/demo/sessions/$($sess.id)/alerts/$($sess.alerts[1].id)/approve"
    $r = Call 'POST' $a2path @{ requestId = (NewId); forecastHorizonHours = 6; phone = '+910000000000' } $key
    Check 'g injected phone -> 400 FIELD_NOT_ALLOWED' ($r.Status -eq 400 -and $r.Json.code -eq 'FIELD_NOT_ALLOWED') "got $($r.Status)"
    $r = Call 'POST' $a2path @{ requestId = (NewId); forecastHorizonHours = 5 } $key
    Check 'h horizon 5 -> 400 UNSUPPORTED_HORIZON' ($r.Status -eq 400 -and $r.Json.code -eq 'UNSUPPORTED_HORIZON') "got $($r.Status)"

    if ($key2) {
      $r = Call 'GET' "/demo/sessions/$($sess.id)" $null $key2
      Check 'i other operator -> 404' ($r.Status -eq 404) "got $($r.Status)"
    } else { Write-Host 'SKIP  i other operator (no second key)' }

    $r = Call 'GET' "/demo/public/$($sess.id)" $null $null
    Check 'j public feed -> 200 exercise, 1 item' ($r.Status -eq 200 -and $r.Json.exercise -eq $true -and $r.Json.items.Count -eq 1 -and $r.Json.items[0].prediction.horizonHours -eq 6) "got $($r.Status)"
    Check 'j no-store header' ($r.Headers -match '(?i)cache-control:\s*no-store') 'missing'
    $leak = @('approvedBy', 'createdBy', 'requestId', 'callStatus', 'demoDestination', 'allowance', 'providerRef', 'provider_ref', 'transcript') | Where-Object { $r.Raw -like "*$_*" }
    Check 'j no private fields' (-not $leak -and ($r.Raw -notmatch '\+\d{8,}')) "leaked: $($leak -join ',')"
    $r = Call 'GET' "/demo/public/$([guid]::NewGuid())" $null $null
    Check 'k unknown public session -> 404' ($r.Status -eq 404) "got $($r.Status)"

    $r = Call 'GET' '/incidents?limit=1' $null $key
    Check 'l existing /incidents still works' ($r.Status -eq 200) "got $($r.Status)"

    Write-Host "`nrequestIds used: $($ids -join ', ')"
    Write-Host "Session id: $($sess.id)"
    Write-Host 'Also confirm in CloudWatch (/aws/lambda/jalnetra-api) that no OmniDimension request was made.'
    if ($script:fails -gt 0) { Write-Host "`n$($script:fails) check(s) FAILED." -ForegroundColor Red; exit 1 }
    Write-Host "`nAll checks passed. STOP here. ALERT_PHONE is still REMOVED; real operations will not have a demo phone until -Phase restore."
  }

  'restore' {
    if (-not (Test-Path $Backup)) { throw "No backup at $Backup. Nothing to restore." }
    Confirm-Step 'Restore ALERT_PHONE into the telephony secret? (only for the controlled real-call test, which needs separate explicit approval)'
    $bak = Get-Content $Backup -Raw | ConvertFrom-Json
    $s = Get-SecretObject
    foreach ($p in $bak.PSObject.Properties) { $s | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force }
    Put-SecretObject $s
    Write-Host 'ALERT_PHONE restored in the secret.'
    Confirm-Step 'Refresh jalnetra-api so new containers re-read the secret? (changes ONLY the value of the existing env var JALNETRA_TELEPHONY_SECRET_VERSION)'
    $vars = (Get-AwsOut lambda get-function-configuration --function-name jalnetra-api --query 'Environment.Variables' --output json) | ConvertFrom-Json
    $vars | Add-Member -NotePropertyName JALNETRA_TELEPHONY_SECRET_VERSION -NotePropertyValue (Get-Date -Format 'yyyyMMddHHmmss') -Force
    $tmp = New-TemporaryFile
    try {
      (@{ Variables = $vars } | ConvertTo-Json -Depth 5 -Compress) | Set-Content -Path $tmp -Encoding ascii
      Invoke-Aws lambda update-function-configuration --function-name jalnetra-api --environment "file://$($tmp.FullName)" | Out-Null
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    Invoke-Aws lambda wait function-updated --function-name jalnetra-api
    Write-Host 'jalnetra-api refreshed. The demo phone is configured again. No call has been placed. Next: -Phase call'
    Write-Host "You can delete $Backup once everything works."
  }

  'call' {
    Write-Host 'REAL CALL TEST: this places ONE real OmniDimension call to the demo phone configured on the server.' -ForegroundColor Yellow
    $sec = Read-Host 'Operator key (hidden)' -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $t = Invoke-Api 'GET' '/telephony' $null $key
    if ($t.Status -ne 200) { throw "GET /telephony failed ($($t.Status))" }
    if (-not $t.Json.demo_phone) { throw 'The server has no demo phone configured (run -Phase restore first).' }
    if ($t.Json.call -ne 'omnidimension') { throw "Call provider is '$($t.Json.call)', expected omnidimension." }
    Write-Host "Server demo phone: $($t.Json.demo_phone)   provider: $($t.Json.call)"
    $s = Invoke-Api 'POST' '/demo/sessions' @{ requestId = [guid]::NewGuid().ToString() } $key
    if ($s.Status -ne 201) { throw "Create session failed ($($s.Status)): $($s.Raw)" }
    if (-not $s.Json.demoDestination.configured) { throw 'Session reports the demo destination is NOT configured. Aborting.' }
    $alert = $s.Json.alerts[0]
    Write-Host "Alert to approve: $($alert.title)"
    Write-Host "Message (exercise): $($alert.messageEn)"
    Write-Host 'This will dial the number ending above. One attempt only. No automatic retry.'
    $a = Read-Host 'Type CALL (capitals) to place the call, anything else to cancel'
    if ($a -ne 'CALL') { throw 'Cancelled. No call was placed.' }
    $r = Invoke-Api 'POST' "/demo/sessions/$($s.Json.id)/alerts/$($alert.id)/approve" @{ requestId = [guid]::NewGuid().ToString(); forecastHorizonHours = 6 } $key
    Write-Host "HTTP $($r.Status)"
    if ($r.Status -ne 200) { Write-Host $r.Raw; throw 'Approve did not return 200. Do not retry blindly: check the session first.' }
    Write-Host "approvalStatus : $($r.Json.alert.approvalStatus)"
    Write-Host "callStatus     : $($r.Json.alert.callStatus)"
    Write-Host "callAttempts   : $($r.Json.alert.callAttempts)"
    Write-Host "note           : $($r.Json.alert.callNote)"
    Write-Host "session id     : $($s.Json.id)"
    Write-Host 'dispatched = OmniDimension accepted the request. It is NOT proof anyone answered. Your phone should ring shortly.'
    Write-Host 'If callStatus is unknown or failed it will NOT be retried. Check the OmniDimension dashboard and CloudWatch before deciding anything.'
  }
}
