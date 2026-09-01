# populate_local.ps1 — PowerShell port of Linux/populate_local.sh
# Syncs local Solr cores (job / company) from production Solr (solr.peviitor.ro).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

$PROD_BASE  = 'https://solr.peviitor.ro/solr'
$LOCAL_BASE = 'http://localhost:8984/solr'
$PROD_USER  = 'solr'
$PROD_PASS  = if ($env:SOLR_PASS) { $env:SOLR_PASS } else { Read-Host 'Parola Solr productie' }
$LOCAL_USER = 'solr'
$LOCAL_PASS = if ($env:SOLR_PASS) { $env:SOLR_PASS } else { $PROD_PASS }
$JOB_FL     = 'url,title,company,company_name,cif,location,tags,workmode,date,status,job_title,city,country,county,remote,salary,source,workplaceType'
$PAGE_SIZE  = 1000

$prodHdr  = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${PROD_USER}:${PROD_PASS}")) }
$localHdr = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${LOCAL_USER}:${LOCAL_PASS}")) }

$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

function Log($m) { Write-Host "[$(Get-Date -Format HH:mm:ss)] $m" }

function Get-Json($uri, $headers) {
    $r = Invoke-WebRequest -Uri $uri -Headers $headers -UseBasicParsing -TimeoutSec 120
    return $ser.DeserializeObject([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()))
}

function Post-Json($uri, $headers, $bodyString) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($bodyString)
    $r = Invoke-WebRequest -Uri $uri -Headers $headers -Method Post -ContentType 'application/json' -Body $bytes -UseBasicParsing -TimeoutSec 300
    return [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}

function Sync-Core($core, $fl) {
    Log "==> Syncing core '$core'"

    # 1. wipe local core
    $wipe = Post-Json "$LOCAL_BASE/$core/update?commit=true" $localHdr '{"delete":{"query":"*:*"}}'
    if ($wipe -notmatch '"status":0') { throw "failed to wipe local core '$core': $wipe" }

    # 2. total count from prod
    $totalObj = Get-Json "$PROD_BASE/$core/select?q=*:*&rows=0&wt=json" $prodHdr
    $total = [int]$totalObj['response']['numFound']
    Log "    prod has $total documents"

    # 3. paginate prod -> local
    $start = 0
    while ($start -lt $total) {
        $uri = "$PROD_BASE/$core/select?q=*:*&rows=$PAGE_SIZE&start=$start&wt=json"
        if ($fl) { $uri += "&fl=$fl" }
        $page = Get-Json $uri $prodHdr
        $docs = $page['response']['docs']
        if (-not $docs -or $docs.Count -eq 0) { Log "    prod returned no docs, stopping"; break }

        foreach ($d in $docs) { [void]$d.Remove('_version_'); [void]$d.Remove('_root_') }

        $body = $ser.Serialize($docs)
        $out = Post-Json "$LOCAL_BASE/$core/update?commitWithin=1000&overwrite=true&wt=json" $localHdr $body
        if ($out -notmatch '"status":0') { throw "failed POSTing page start=$start : $out" }

        $start += $PAGE_SIZE
        Log "    pushed $([Math]::Min($start,$total)) / $total"
    }

    # 4. final commit
    Post-Json "$LOCAL_BASE/$core/update" $localHdr '{"commit":{}}' | Out-Null

    # 5. verify
    $localObj = Get-Json "$LOCAL_BASE/$core/select?q=*:*&rows=0&wt=json" $localHdr
    Log "    DONE: local '$core' has $([int]$localObj['response']['numFound']) documents"
}

Sync-Core 'job' $JOB_FL
Sync-Core 'company' ''
Log '==> All cores synced.'
