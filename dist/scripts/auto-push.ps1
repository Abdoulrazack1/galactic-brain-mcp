# Galactic Brain — Auto-push toutes les 30 min
# Appelé par Task Scheduler. Silencieux si rien à pusher.
# Loggé dans %LOCALAPPDATA%\GalacticBrain\auto-push.log

$VaultRoot = "C:\Users\PC\Documents\Obsidian Vault\GalacticBrain"
$LogDir    = "$env:LOCALAPPDATA\GalacticBrain"
$LogFile   = "$LogDir\auto-push.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log($msg) {
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path $LogFile -Value "$ts  $msg" -Encoding utf8
}

# Rotation log : garde 500 dernières lignes
if (Test-Path $LogFile) {
  $lines = Get-Content $LogFile -Tail 500
  Set-Content -Path $LogFile -Value $lines -Encoding utf8
}

try {
  Set-Location $VaultRoot

  # Vérifier qu'on est dans un repo git
  $isRepo = git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERREUR : $VaultRoot n'est pas un repo git"
    exit 1
  }

  # Statut : y a-t-il des changements ?
  $status = git status --porcelain
  if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Log "no-op (clean)"
    exit 0
  }

  $nbFiles = ($status -split "`n").Count
  Write-Log "$nbFiles fichier(s) modifié(s), commit + push..."

  # Stage tout
  git add -A 2>&1 | Out-Null

  # Commit
  $commitMsg = "auto-sync $(Get-Date -Format 'yyyy-MM-dd HH:mm') · $nbFiles file(s)"
  $commitOut = git commit -m $commitMsg 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Log "commit echoué : $commitOut"
    exit 1
  }

  # Push (seulement si remote configuré)
  $remoteCheck = git remote 2>$null
  if ([string]::IsNullOrWhiteSpace($remoteCheck)) {
    Write-Log "commit OK, mais pas de remote configuré — pas de push"
    exit 0
  }

  $pushOut = git push 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Log "push échoué : $pushOut"
    exit 1
  }

  Write-Log "✓ push OK ($commitMsg)"
  exit 0
} catch {
  Write-Log "EXCEPTION : $_"
  exit 1
}
