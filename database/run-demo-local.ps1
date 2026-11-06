param([string]$ResumeRun)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '3306'
$env:DB_NAME = 'wardrobe_demo'
$env:DB_USER = 'root'
$dbSecret = Read-Host 'MySQL password (hidden)' -AsSecureString
$dbPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($dbSecret)
try {
    $env:DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($dbPtr)
    do {
        $demoSecret = Read-Host 'Demo password (8-64 characters, hidden; keep it for later login)' -AsSecureString
        $demoPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($demoSecret)
        try { $env:DEMO_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($demoPtr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($demoPtr); $demoSecret.Dispose() }
        $characterCount = [int](node -e 'console.log(Array.from(process.env.DEMO_PASSWORD).length)')
        if ($characterCount -lt 8 -or $characterCount -gt 64) { Write-Host "Entered $characterCount characters; enter 8-64 characters. No database writes have started." }
    } while ($characterCount -lt 8 -or $characterCount -gt 64)
    if ($ResumeRun) { node database/run-demo-local.mjs --resume $ResumeRun }
    else { node database/run-demo-local.mjs --execute }
    $resultCode = $LASTEXITCODE
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($dbPtr)
    $dbSecret.Dispose()
    Remove-Item Env:DB_PASSWORD, Env:DEMO_PASSWORD -ErrorAction SilentlyContinue
}
Write-Host "P2-03 process exit code: $resultCode. Close this window after reading the result."
